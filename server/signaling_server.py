#!/usr/bin/env python3
"""Small dependency-free WebSocket room server for Project Vera.

The server owns room membership and relays compact, validated state/control
packets. This keeps the static GitHub Pages frontend simple and allows rooms
of up to twenty players without a browser-to-browser WebRTC mesh.

Run locally:
    python server/signaling_server.py --host 0.0.0.0 --port 8765

For a public HTTPS/WSS deployment, terminate TLS here with --certfile and
--keyfile, or put this process behind a TLS reverse proxy.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import secrets
import socket
import ssl
import struct
import threading
import time
from typing import Any, Dict, Optional


LOG = logging.getLogger("vera.signaling")
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
MAX_FRAME_BYTES = 256 * 1024
MAX_HEADER_BYTES = 16 * 1024
ROOM_TTL_SECONDS = 60 * 60 * 6
MAX_PLAYERS = 20


def clean_room_code(value: Any) -> str:
    code = "".join(ch for ch in str(value or "").upper() if ch.isalnum())
    return code[:12]


def json_message(message: Dict[str, Any]) -> bytes:
    return json.dumps(message, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


class ProtocolError(Exception):
    pass


class Client:
    def __init__(self, server: "SignalingServer", connection: socket.socket, address: Any):
        self.server = server
        self.connection = connection
        self.address = address
        self.room_code = ""
        self.role = ""
        self.slot = 0
        self.closed = False
        self.send_lock = threading.Lock()
        self.buffer = bytearray()

    def send(self, message: Dict[str, Any]) -> bool:
        payload = json_message(message)
        if len(payload) > MAX_FRAME_BYTES:
            return False
        frame = self.make_frame(payload)
        try:
            with self.send_lock:
                self.connection.sendall(frame)
            return True
        except OSError:
            return False

    @staticmethod
    def make_frame(payload: bytes, opcode: int = 0x1) -> bytes:
        length = len(payload)
        first = 0x80 | (opcode & 0x0F)
        if length < 126:
            return bytes((first, length)) + payload
        if length < 65536:
            return bytes((first, 126)) + struct.pack(">H", length) + payload
        return bytes((first, 127)) + struct.pack(">Q", length) + payload

    def read_exact(self, size: int) -> bytes:
        while len(self.buffer) < size:
            chunk = self.connection.recv(min(65536, size - len(self.buffer)))
            if not chunk:
                raise ConnectionError("peer closed")
            self.buffer.extend(chunk)
        value = bytes(self.buffer[:size])
        del self.buffer[:size]
        return value

    def read_frame(self) -> Optional[tuple[int, bytes]]:
        header = self.read_exact(2)
        first, second = header
        fin = bool(first & 0x80)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if not fin or opcode == 0x0:
            raise ProtocolError("fragmented WebSocket frames are not supported")
        if length == 126:
            length = struct.unpack(">H", self.read_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self.read_exact(8))[0]
        if length > MAX_FRAME_BYTES:
            raise ProtocolError("WebSocket frame is too large")
        if not masked:
            raise ProtocolError("client WebSocket frame was not masked")
        mask = self.read_exact(4)
        payload = bytearray(self.read_exact(length))
        for index in range(length):
            payload[index] ^= mask[index % 4]
        return opcode, bytes(payload)

    def handshake(self) -> bool:
        while b"\r\n\r\n" not in self.buffer:
            chunk = self.connection.recv(4096)
            if not chunk:
                return False
            self.buffer.extend(chunk)
            if len(self.buffer) > MAX_HEADER_BYTES:
                return False
        header_end = self.buffer.index(b"\r\n\r\n") + 4
        raw = bytes(self.buffer[:header_end])
        del self.buffer[:header_end]
        lines = raw.decode("latin-1").split("\r\n")
        request = lines[0].split(" ")
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.strip().lower()] = value.strip()
        path = request[1] if len(request) > 1 else ""
        if path.split("?", 1)[0] == "/healthz":
            body = b"vera-signaling-ok\n"
            response = (
                b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"
                + (b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n")
                + b"Connection: close\r\n\r\n"
                + body
            )
            self.connection.sendall(response)
            return False
        if len(request) < 3 or request[0] != "GET" or path.split("?", 1)[0] != "/signal":
            self.connection.sendall(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
            return False
        key = headers.get("sec-websocket-key")
        if headers.get("upgrade", "").lower() != "websocket" or not key:
            self.connection.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            return False
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest())
        response = (
            b"HTTP/1.1 101 Switching Protocols\r\n"
            b"Upgrade: websocket\r\n"
            b"Connection: Upgrade\r\n"
            b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n"
        )
        self.connection.sendall(response)
        return True

    def run(self) -> None:
        try:
            self.connection.settimeout(None)
            if not self.handshake():
                return
            self.server.register(self)
            while not self.closed:
                frame = self.read_frame()
                if frame is None:
                    break
                opcode, payload = frame
                if opcode == 0x8:
                    break
                if opcode == 0x9:
                    self.connection.sendall(self.make_frame(payload, 0xA))
                    continue
                if opcode != 0x1:
                    raise ProtocolError("unsupported WebSocket opcode")
                if len(payload) > MAX_FRAME_BYTES:
                    raise ProtocolError("message is too large")
                try:
                    message = json.loads(payload.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    self.send({"type": "error", "message": "Malformed signaling message."})
                    continue
                if isinstance(message, dict):
                    self.server.handle(self, message)
        except (ConnectionError, OSError, ProtocolError) as error:
            LOG.debug("client %s ended: %s", self.address, error)
        finally:
            self.server.disconnect(self)
            try:
                self.connection.close()
            except OSError:
                pass

    def close(self) -> None:
        self.closed = True
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.connection.close()
        except OSError:
            pass


class SignalingServer:
    def __init__(self, host: str, port: int, certfile: str = "", keyfile: str = ""):
        self.host = host
        self.port = port
        self.certfile = certfile
        self.keyfile = keyfile
        self.clients = set()
        self.rooms: Dict[str, Dict[str, Any]] = {}
        self.lock = threading.RLock()
        self.listener: Optional[socket.socket] = None

    def new_room_code(self) -> str:
        with self.lock:
            for _ in range(100):
                code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(6))
                if code not in self.rooms:
                    return code
        raise RuntimeError("Could not allocate a room code")

    def register(self, client: Client) -> None:
        with self.lock:
            self.clients.add(client)

    def handle(self, client: Client, message: Dict[str, Any]) -> None:
        action = str(message.get("action", ""))
        LOG.debug("client %s action=%s room=%s slot=%s", client.address, action, client.room_code or "-", client.slot)
        if action == "create":
            self.create_room(client)
        elif action == "join":
            self.join_room(client, clean_room_code(message.get("code")))
        elif action == "signal":
            self.relay_signal(client, message.get("data"))
        elif action == "state":
            self.relay_state(client, message.get("data"))
        elif action == "control":
            self.relay_control(client, message.get("data"))
        elif action == "list":
            self.send_room_list(client)
        elif action == "leave":
            client.closed = True
            self.disconnect(client)
        else:
            client.send({"type": "error", "message": "Unknown signaling action."})

    def create_room(self, client: Client) -> None:
        with self.lock:
            if client.room_code:
                client.send({"type": "error", "message": "This browser is already in a room."})
                return
            code = self.new_room_code()
            self.rooms[code] = {"host": client, "guests": {}, "offer": None, "created": time.time(), "next_slot": 1}
            client.room_code = code
            client.role = "host"
            client.slot = 0
        client.send({"type": "room-created", "code": code, "role": "host"})
        self.send_room_list_to_all()

    def join_room(self, client: Client, code: str) -> None:
        if len(code) != 6:
            client.send({"type": "error", "message": "Enter a valid six-character room code."})
            return
        with self.lock:
            room = self.rooms.get(code)
            if not room or time.time() - room["created"] >= ROOM_TTL_SECONDS:
                client.send({"type": "error", "message": "That room is not available."})
                return
            if len(room["guests"]) >= MAX_PLAYERS - 1:
                client.send({"type": "error", "message": "That room is full."})
                return
            used_slots = {0, *room["guests"].keys()}
            slot = next((candidate for candidate in range(1, MAX_PLAYERS) if candidate not in used_slots), None)
            if slot is None:
                client.send({"type": "error", "message": "That room is full."})
                return
            room["guests"][slot] = client
            client.room_code = code
            client.role = "guest"
            client.slot = slot
            host = room["host"]
            offer = room.get("offer")
            players = self.players_snapshot(room)
        client.send({"type": "room-joined", "code": code, "role": "guest", "slot": slot, "players": players})
        host.send({"type": "player-joined", "code": code, "slot": slot, "players": players})
        if offer:
            client.send({"type": "signal", "from": "host", "data": offer})
        self.send_room_list_to_all()

    @staticmethod
    def players_snapshot(room: Dict[str, Any]) -> list[Dict[str, Any]]:
        players = [{"slot": 0, "role": "host"}]
        players.extend({"slot": slot, "role": "guest"} for slot in sorted(room["guests"]))
        return players

    def relay_signal(self, client: Client, data: Any) -> None:
        if not isinstance(data, dict):
            client.send({"type": "error", "message": "Invalid signaling payload."})
            return
        signal_type = str(data.get("type", ""))
        value = data.get("value")
        if signal_type not in ("offer", "answer") or not isinstance(value, str) or len(value) > MAX_FRAME_BYTES:
            client.send({"type": "error", "message": "Unsupported signaling payload."})
            return
        with self.lock:
            room = self.rooms.get(client.room_code)
            if not room:
                client.send({"type": "error", "message": "Room is no longer available."})
                return
            if signal_type == "offer" and client.role == "host":
                room["offer"] = data
            target = room["guests"].get(int(data.get("slot", 0))) if client.role == "host" else room["host"]
        if target:
            target.send({"type": "signal", "from": client.role, "data": data})

    def relay_state(self, client: Client, data: Any) -> None:
        if not isinstance(data, str) or len(data) > 512:
            client.send({"type": "error", "message": "Invalid player state packet."})
            return
        with self.lock:
            room = self.rooms.get(client.room_code)
            if not room:
                client.send({"type": "error", "message": "Room is no longer available."})
                return
            peers = [room["host"], *room["guests"].values()]
        for peer in peers:
            if peer and peer is not client:
                peer.send({"type": "state", "slot": client.slot, "data": data})

    def relay_control(self, client: Client, data: Any) -> None:
        if not isinstance(data, dict) or not isinstance(data.get("type"), str) or len(json_message(data)) > 8192:
            client.send({"type": "error", "message": "Invalid multiplayer control packet."})
            return
        with self.lock:
            room = self.rooms.get(client.room_code)
            if not room:
                client.send({"type": "error", "message": "Room is no longer available."})
                return
            peers = [room["host"], *room["guests"].values()]
        for peer in peers:
            if peer and peer is not client:
                peer.send({"type": "control", "slot": client.slot, "data": data})

    def send_room_list(self, client: Client) -> None:
        with self.lock:
            rooms = [
                {"code": code, "players": 1 + len(room["guests"]), "status": "waiting" if not room["guests"] else "playing"}
                for code, room in self.rooms.items()
                if room["host"] is not None and time.time() - room["created"] < ROOM_TTL_SECONDS
            ]
        client.send({"type": "room-list", "rooms": rooms})

    def send_room_list_to_all(self) -> None:
        with self.lock:
            clients = list(self.clients)
        for client in clients:
            self.send_room_list(client)

    def disconnect(self, client: Client) -> None:
        LOG.debug("disconnect client %s room=%s slot=%s", client.address, client.room_code or "-", client.slot)
        with self.lock:
            self.clients.discard(client)
            code = client.room_code
            if not code:
                return
            room = self.rooms.get(code)
            client.room_code = ""
            if not room:
                return
            if room["host"] is client:
                guests = list(room.get("guests", {}).values())
                self.rooms.pop(code, None)
                for guest in guests:
                    guest.room_code = ""
                    guest.role = ""
                    guest.send({"type": "room-closed", "code": code})
            elif client.slot in room.get("guests", {}):
                room["guests"].pop(client.slot, None)
                host = room.get("host")
                peers = [host, *room["guests"].values()]
                for peer in peers:
                    if peer:
                        peer.send({"type": "player-left", "code": code, "slot": client.slot})
        self.send_room_list_to_all()

    def serve_forever(self) -> None:
        listener = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind((self.host, self.port))
        except OSError:
            listener.close()
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind((self.host, self.port))
        listener.listen(64)
        self.listener = listener
        if self.certfile and self.keyfile:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(self.certfile, self.keyfile)
            LOG.info("TLS enabled")
        else:
            context = None
            LOG.warning("Plain WebSocket mode: use only behind a trusted TLS proxy or on a private LAN.")
        LOG.info("Vera signaling listening on %s:%d", self.host, self.port)
        try:
            while True:
                connection, address = listener.accept()
                if context:
                    try:
                        connection = context.wrap_socket(connection, server_side=True)
                    except ssl.SSLError:
                        connection.close()
                        continue
                client = Client(self, connection, address)
                threading.Thread(target=client.run, name="vera-client", daemon=True).start()
        except KeyboardInterrupt:
            LOG.info("Stopping signaling server")
        finally:
            listener.close()
            with self.lock:
                clients = list(self.clients)
                self.clients.clear()
                self.rooms.clear()
            for client in clients:
                client.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Project Vera browser signaling server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address; use 0.0.0.0 for LAN access")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--certfile", default="", help="PEM certificate for WSS")
    parser.add_argument("--keyfile", default="", help="PEM private key for WSS")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    SignalingServer(args.host, args.port, args.certfile, args.keyfile).serve_forever()


if __name__ == "__main__":
    main()
