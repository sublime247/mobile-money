import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { Router } from "express";
import { transactionQueue } from "./transactionQueue";
import { syncQueue } from "./syncQueue";

export function createQueueDashboard() {
  const router = Router();
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");

  createBullBoard({
    queues: [
      new BullMQAdapter(transactionQueue as any, { readOnlyMode: false }),
      new BullMQAdapter(syncQueue as any, { readOnlyMode: false }),
    ],
    serverAdapter: serverAdapter,
    options: {
      uiConfig: {
        boardTitle: "Mobile Money Queue Dashboard",
      },
    },
  });

  router.use("/", serverAdapter.getRouter());

  return router;
}
