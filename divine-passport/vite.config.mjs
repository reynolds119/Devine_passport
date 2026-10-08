import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "");
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY before building.");
  }

  return {
    root,
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, "index.html"),
          give: resolve(root, "give.html"),
          home: resolve(root, "home.html"),
          login: resolve(root, "login.html"),
          resetPassword: resolve(root, "reset-password.html"),
          register: resolve(root, "register.html"),
          saved: resolve(root, "saved.html"),
          profile: resolve(root, "profile.html"),
          adminDashboard: resolve(root, "admin/dashboard.html"),
          adminLogin: resolve(root, "admin/login.html"),
          adminScriptures: resolve(root, "admin/scriptures.html"),
          adminSignups: resolve(root, "admin/signups.html"),
        },
      },
    },
  };
});