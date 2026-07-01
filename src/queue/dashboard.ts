import { Router } from "express";

export function createQueueDashboard() {
  const router = Router();
  
  router.get("/", (_req, res) => {
    res.send(`
      <html>
        <head>
          <title>Queue Dashboard</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #121214; color: #e1e1e6; padding: 40px; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background-color: #202024; border: 1px solid #323238; border-radius: 8px; padding: 32px; max-width: 480px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
            h1 { color: #00adb5; margin-top: 0; }
            p { line-height: 1.6; color: #a8a8b3; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Queue Dashboard</h1>
            <p>The queue processing system has been migrated to RabbitMQ for high-throughput and reliability.</p>
            <p>Please monitor your queues and consumer groups directly via the RabbitMQ Management console.</p>
          </div>
        </body>
      </html>
    `);
  });

  return router;
}
