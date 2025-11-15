const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log(`Valence WebSocket server listening on port ${PORT}`);

const COLORS = ["red", "blue", "yel", "grn"];

// rooms: roomCode -> { code, state, players: [{ id, name, color, ws }] }
const rooms = new Map();

function generateRoomCode(length = 4) {
  const chars = "ABCDEFGHJKMNPQRTUVWXYZ2346789"; // avoid confusing chars
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function assignColor(room) {
  const used = new Set(room.players.map(p => p.color));
  for (const c of COLORS) {
    if (!used.has(c)) return c;
  }
  return null; // room full
}

function broadcastToRoom(room, messageObj) {
  const json = JSON.stringify(messageObj);
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(json);
    }
  }
}

function getRoomByCode(code) {
  return rooms.get(code.toUpperCase());
}

wss.on("connection", ws => {
  const clientId = uuidv4();
  ws.clientId = clientId;
  ws.currentRoomCode = null;

  ws.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error("Bad JSON from client:", e);
      return;
    }

    const type = msg.type;
    if (!type) return;

    // --- CREATE ROOM ---
    if (type === "createRoom") {
      const name = msg.playerName || "Player";
      let roomCode;
      do {
        roomCode = generateRoomCode();
      } while (rooms.has(roomCode));

      const room = {
        code: roomCode,
        state: null, // will be set when host sends first update
        players: []
      };
      rooms.set(roomCode, room);

      const color = assignColor(room);
      if (!color) {
        ws.send(JSON.stringify({ type: "error", message: "Room full." }));
        return;
      }

      const player = { id: clientId, name, color, ws };
      room.players.push(player);
      ws.currentRoomCode = roomCode;

      ws.send(JSON.stringify({
        type: "roomCreated",
        roomCode,
        you: { id: clientId, name, color },
        players: room.players.map(p => ({
          id: p.id,
          name: p.name,
          color: p.color
        })),
        state: room.state
      }));

      console.log(`Room ${roomCode} created by ${name} (${clientId})`);
    }

    // --- JOIN ROOM ---
    else if (type === "joinRoom") {
      const code = (msg.roomCode || "").toUpperCase();
      const name = msg.playerName || "Player";
      const room = getRoomByCode(code);

      if (!room) {
        ws.send(JSON.stringify({ type: "error", message: "Room not found." }));
        return;
      }

      const color = assignColor(room);
      if (!color) {
        ws.send(JSON.stringify({ type: "error", message: "Room is full." }));
        return;
      }

      const player = { id: clientId, name, color, ws };
      room.players.push(player);
      ws.currentRoomCode = code;

      // notify joining client
      ws.send(JSON.stringify({
        type: "roomJoined",
        roomCode: code,
        you: { id: clientId, name, color },
        players: room.players.map(p => ({
          id: p.id,
          name: p.name,
          color: p.color
        })),
        state: room.state
      }));

      // broadcast updated player list to everyone
      broadcastToRoom(room, {
        type: "playersUpdate",
        roomCode: code,
        players: room.players.map(p => ({
          id: p.id,
          name: p.name,
          color: p.color
        }))
      });

      console.log(`Player ${name} (${clientId}) joined room ${code}`);
    }

    // --- STATE UPDATE (hosted on client for now) ---
    else if (type === "updateState") {
      const code = (msg.roomCode || "").toUpperCase();
      const room = getRoomByCode(code);
      if (!room) {
        ws.send(JSON.stringify({ type: "error", message: "Room not found." }));
        return;
      }
      if (!msg.state) {
        ws.send(JSON.stringify({ type: "error", message: "Missing state." }));
        return;
      }

      room.state = msg.state;

      broadcastToRoom(room, {
        type: "stateUpdate",
        roomCode: code,
        state: room.state
      });
    }

    // --- SIMPLE PING/PONG ---
    else if (type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  });

  ws.on("close", () => {
    const roomCode = ws.currentRoomCode;
    if (!roomCode) return;
    const room = getRoomByCode(roomCode);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== clientId);
    if (room.players.length === 0) {
      rooms.delete(roomCode);
      console.log(`Room ${roomCode} deleted (empty).`);
    } else {
      broadcastToRoom(room, {
        type: "playersUpdate",
        roomCode,
        players: room.players.map(p => ({
          id: p.id,
          name: p.name,
          color: p.color
        }))
      });
    }
  });
});
