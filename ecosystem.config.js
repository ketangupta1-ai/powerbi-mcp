module.exports = {
  apps: [
    {
      name: "powerbi-mcp",
      script: "src/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: 3101,
        HOST: "127.0.0.1",
        BASIC_AUTH_USER: "powerbi",
        BASIC_AUTH_PASSWORD: "powerbi123"
      }
    }
  ]
};
