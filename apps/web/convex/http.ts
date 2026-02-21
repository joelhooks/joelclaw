import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();

// Register Better Auth route handlers
authComponent.registerRoutes(http, createAuth);

export default http;
