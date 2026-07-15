const isProduction = process.env.NODE_ENV === "production";
const backendHost = process.env.NSTACK_BACKEND_HOST || "backend";
const publicApiBaseUrl =
  process.env.NUXT_PUBLIC_API_BASE_URL ||
  process.env.NUXT_PUBLIC_NSTACK_API_BASE_URL ||
  process.env.NSTACK_PUBLIC_API_BASE_URL ||
  "/api";
const serverApiBaseUrl =
  process.env.NUXT_API_SERVER_BASE_URL ||
  process.env.NUXT_API_INTERNAL_BASE_URL ||
  process.env.NSTACK_API_BASE_URL ||
  (isProduction ? `http://${backendHost}:8080` : "http://localhost:4000");

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  modules: ["@nuxt/fonts", "@nuxt/icon", "@vueuse/nuxt"],
  css: ["~/assets/css/main.css"],
  future: {
    compatibilityVersion: 4,
  },
  app: {
    head: {
      htmlAttrs: {
        lang: "en",
      },
      title: "Model Market",
      titleTemplate: "%s | Model Market",
      meta: [
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "theme-color", content: "#0a0c0a" },
      ],
    },
    pageTransition: {
      name: "page",
      mode: "out-in",
    },
  },
  fonts: {
    families: [
      {
        name: "Instrument Sans",
        provider: "google",
        weights: [400, 500, 600, 700],
        styles: ["normal"],
        subsets: ["latin"],
        global: true,
      },
      {
        name: "IBM Plex Mono",
        provider: "google",
        weights: [400, 500, 600],
        styles: ["normal"],
        subsets: ["latin"],
        global: true,
      },
    ],
  },
  experimental: {
    buildCache: true,
  },
  sourcemap: false,
  vite: {
    build: {
      reportCompressedSize: false,
    },
  },
  nitro: {
    preset: "node-server",
    sourceMap: false,
    devProxy: {
      "/api": {
        target: serverApiBaseUrl,
        changeOrigin: true,
      },
    },
  },
  runtimeConfig: {
    apiServerBaseUrl: serverApiBaseUrl,
    public: {
      apiBaseUrl: publicApiBaseUrl,
    },
  },
  typescript: {
    strict: true,
  },
});
