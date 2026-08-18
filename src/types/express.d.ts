import "express";

export interface AuthedUser {
  discordId: string;
  username: string;
  globalRole: "root" | "user";
  timezone: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthedUser;
  }
}
