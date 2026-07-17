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
const themeInitScript = `(() => {
  const root = document.documentElement;
  let theme = "dark";
  try {
    const stored = localStorage.getItem("model-market-theme");
    if (stored === "light" || stored === "dark") theme = stored;
  } catch {}
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
})();`;

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: false },
  modules: ["@nuxt/fonts", "@nuxt/icon", "@vueuse/nuxt"],
  icon: {
    provider: "none",
    clientBundle: {
      scan: true,
      icons: [
        "ph:arrow-line-down",
        "ph:arrow-up-right",
        "ph:arrows-clockwise",
        "ph:bank",
        "ph:brackets-curly",
        "ph:caret-down",
        "ph:check-circle",
        "ph:circle-notch",
        "ph:link",
        "ph:pause-circle",
        "ph:play-circle",
        "ph:play-fill",
        "ph:shield-check",
        "ph:shield-warning",
        "ph:sign-in",
        "ph:stop-circle",
        "ph:sun",
        "ph:terminal-window",
        "ph:moon",
        "ph:warning-circle",
        "ph:waveform",
        "ph:x-logo",
      ],
    },
  },
  css: ["~/assets/css/main.css"],
  future: {
    compatibilityVersion: 4,
  },
  app: {
    head: {
      htmlAttrs: {
        lang: "en",
      },
      title: "RobinArena",
      titleTemplate: "%s | RobinArena",
      meta: [
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "theme-color", content: "#0a0c0a" },
      ],
      script: [
        {
          id: "model-market-theme-init",
          innerHTML: themeInitScript,
          tagPosition: "head",
          tagPriority: "critical",
        },
      ],
      link: [
        { rel: "icon", type: "image/svg+xml", href: "/brand/robinarena-mark.svg" },
        { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
        { rel: "icon", type: "image/png", sizes: "64x64", href: "/favicon.png" },
        { rel: "apple-touch-icon", sizes: "192x192", href: "/icon-192.png" },
        { rel: "manifest", href: "/site.webmanifest" },
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
        name: "Onest",
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
