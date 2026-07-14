export default {
  app: {
    name: "robinshark",
    slug: "robinshark",
  },
  paths: {
    frontendContext: ".",
  },
  verify: {
    timeoutSeconds: 120,
    endpoints: [
      { name: "ready", path: "/api/ready", expectStatus: 200 },
    ],
  },
};
