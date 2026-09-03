import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { authMode } from "@/lib/auth-mode";

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Our generated Prisma client (custom output path, Prisma 7 driver-adapter architecture) is
  // structurally identical to `@prisma/client`'s `PrismaClient` but nominally a different type,
  // and `@prisma/client` itself has no generated output here (no default `PrismaClient` export).
  adapter: PrismaAdapter(prisma as never),
  // Needed since the app runs behind a non-default host/port (e.g. localhost:3100) without AUTH_URL set.
  trustHost: true,

  providers: authMode === "entra"
    ? [
        MicrosoftEntraID({
          clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID!,
          clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
        }),
      ]
    : [],
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
});
