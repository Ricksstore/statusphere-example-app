import events from "node:events";
import type http from "node:http";
import express, { type Express } from "express";
import { pino } from "pino";
import type { OAuthClient } from "@atproto/oauth-client-node";
import { Firehose } from "@atproto/sync";
import { Server as SocketIOServer } from "socket.io";

import { createDb, migrateToLatest } from "#/db";
import { env } from "#/lib/env";
import { createIngester } from "#/ingester";
import { createRouter } from "#/routes";
import { createClient } from "#/auth/client";
import {
  createBidirectionalResolver,
  createIdResolver,
  BidirectionalResolver,
} from "#/id-resolver";
import type { Database } from "#/db";
import { IdResolver, MemoryCache } from "@atproto/identity";

// Application state passed to the router and elsewhere
export type AppContext = {
  db: Database;
  ingester: Firehose;
  logger: pino.Logger;
  oauthClient: OAuthClient;
  resolver: BidirectionalResolver;
  io: SocketIOServer;
};

// Room management
const waitingUsers: Map<string, { socketId: string; profile: any }> = new Map();
const activeRooms: Map<string, { user1: string; user2: string }> = new Map();

function setupSocketHandlers(io: SocketIOServer, ctx: AppContext) {
  io.on("connection", (socket) => {
    ctx.logger.info(`Client connected: ${socket.id}`);

    socket.on("join-waiting", async (profile) => {
      ctx.logger.info(`User joining waiting room: ${profile.handle}`);

      // Store user info
      waitingUsers.set(socket.id, { socketId: socket.id, profile });

      // Join waiting room
      socket.join("waiting");

      // Check if we can match with someone
      if (waitingUsers.size >= 2) {
        const users = Array.from(waitingUsers.values());
        const user1 = users[0];
        const user2 = users[1];

        // Create a room
        const roomId = `room_${Date.now()}`;
        activeRooms.set(roomId, {
          user1: user1.socketId,
          user2: user2.socketId,
        });

        // Remove from waiting
        waitingUsers.delete(user1.socketId);
        waitingUsers.delete(user2.socketId);

        // Move users to the room
        socket.to(user1.socketId).socketsJoin(roomId);
        socket.to(user2.socketId).socketsJoin(roomId);
        socket.join(roomId);

        // Notify users about their partner
        io.to(user1.socketId).emit("room-update", {
          partner: user2.profile,
          isWaiting: false,
        });
        io.to(user2.socketId).emit("room-update", {
          partner: user1.profile,
          isWaiting: false,
        });

        ctx.logger.info(`Matched users in room: ${roomId}`);
      } else {
        // Still waiting
        socket.emit("room-update", { isWaiting: true });
      }
    });

    socket.on("typing", (message) => {
      // Find the room this user is in
      for (const [roomId, room] of activeRooms.entries()) {
        if (room.user1 === socket.id || room.user2 === socket.id) {
          const partnerId = room.user1 === socket.id ? room.user2 : room.user1;
          socket.to(partnerId).emit("partner-typing", message);
          break;
        }
      }
    });

    socket.on("rejoin-room", (data) => {
      ctx.logger.info(`User rejoining room: ${data.profile.handle}`);

      // Check if the room still exists
      if (data.roomId && activeRooms.has(data.roomId)) {
        const room = activeRooms.get(data.roomId);
        if (room) {
          // Find which user this is based on profile
          let isUser1 = false;
          let isUser2 = false;

          // We need to check if this user was in the room before
          // For now, we'll just add them to the room and let them reconnect
          socket.join(data.roomId);

          // Notify the partner that user reconnected
          const partnerId = room.user1 === socket.id ? room.user2 : room.user1;
          if (partnerId) {
            socket.to(partnerId).emit("partner-reconnected", data.profile);
          }

          // Send room update to the reconnecting user
          socket.emit("room-update", {
            partner: data.partner,
            roomId: data.roomId,
            isWaiting: false,
          });
        }
      } else {
        // Room no longer exists, rejoin waiting room
        socket.emit("join-waiting", data.profile);
      }
    });

    socket.on("disconnect", () => {
      ctx.logger.info(`Client disconnected: ${socket.id}`);

      // Remove from waiting if they were waiting
      if (waitingUsers.has(socket.id)) {
        waitingUsers.delete(socket.id);
      }

      // Handle room cleanup
      for (const [roomId, room] of activeRooms.entries()) {
        if (room.user1 === socket.id || room.user2 === socket.id) {
          const partnerId = room.user1 === socket.id ? room.user2 : room.user1;

          // Notify partner that user left
          socket.to(partnerId).emit("partner-left");

          // Clean up room
          activeRooms.delete(roomId);
          break;
        }
      }
    });
  });
}

export class Server {
  constructor(
    public app: express.Application,
    public server: http.Server,
    public ctx: AppContext
  ) {}

  static async create() {
    const { NODE_ENV, HOST, PORT, DB_PATH } = env;
    const logger = pino({ name: "server start" });

    // Set up the SQLite database
    const db = createDb(DB_PATH);
    await migrateToLatest(db);

    // Create the atproto utilities
    const oauthClient = await createClient(db);
    const baseIdResolver = createIdResolver();
    const ingester = createIngester(db, baseIdResolver);
    const resolver = createBidirectionalResolver(baseIdResolver);
    const ctx = {
      db,
      ingester,
      logger,
      oauthClient,
      resolver,
    };

    // Subscribe to events on the firehose
    ingester.start();

    // Create our server
    const app: Express = express();
    app.set("trust proxy", true);

    // Routes & middlewares
    const router = createRouter(ctx);
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(router);
    app.use((_req, res) => res.sendStatus(404));

    // Bind our server to the port
    const server = app.listen(env.PORT);
    await events.once(server, "listening");

    // Create Socket.IO server
    const io = new SocketIOServer(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
    });

    // Add Socket.IO to context
    ctx.io = io;

    // Set up Socket.IO handlers
    setupSocketHandlers(io, ctx);

    logger.info(`Server (${NODE_ENV}) running on port http://${HOST}:${PORT}`);

    return new Server(app, server, ctx);
  }

  async close() {
    this.ctx.logger.info("sigint received, shutting down");
    await this.ctx.ingester.destroy();
    return new Promise<void>((resolve) => {
      this.server.close(() => {
        this.ctx.logger.info("server closed");
        resolve();
      });
    });
  }
}

const run = async () => {
  const server = await Server.create();

  const onCloseSignal = async () => {
    setTimeout(() => process.exit(1), 10000).unref(); // Force shutdown after 10s
    await server.close();
    process.exit();
  };

  process.on("SIGINT", onCloseSignal);
  process.on("SIGTERM", onCloseSignal);
};

run();
