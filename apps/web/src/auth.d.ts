import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      backendId?: string;
      email: string;
      name?: string | null;
      image?: string | null;
    };
  }
}
