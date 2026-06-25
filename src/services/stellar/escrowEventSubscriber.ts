// src/services/stellar/escrowEventSubscriber.ts
import { getStellarServer } from "../config/stellar";
import { insertEscrowEvent } from "../../database/escrowEventRepository";
import EventSource from "eventsource";

interface EscrowEventPayload {
  escrowId: string;
  amount: string;
  asset: string;
  // Add more fields as needed
}

type EscrowEventType = "lock" | "release";

export function startEventSubscription() {
  const horizon = getStellarServer();
  const horizonUrl = (horizon as any).serverURL || horizon.host; // fallback
  const escrowContractId = process.env.ESCROW_CONTRACT_ID;
  if (!escrowContractId) {
    console.warn("ESCROW_CONTRACT_ID not set – Horizon event subscription disabled");
    return;
  }

  const streamUrl = `${horizonUrl}/accounts/${escrowContractId}/transactions?cursor=now&limit=200&order=asc`;
  const es = new EventSource(streamUrl);

  es.onmessage = async (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (!data || !data._embedded?.records) return;
      for (const tx of data._embedded.records) {
        const opsResponse = await horizon.operations().forTransaction(tx.id).call();
        for (const op of opsResponse.records) {
          if (op.type !== "contract_event") continue;
          if (op.contract !== escrowContractId) continue;
          const eventType: EscrowEventType = op.value?.type;
          if (eventType !== "lock" && eventType !== "release") continue;
          const payload: EscrowEventPayload = op.value?.payload || {};
          await insertEscrowEvent({
            tx_hash: tx.hash,
            ledger: tx.ledger_seq,
            event_type: eventType,
            payload,
            created_at: new Date(),
          });
        }
      }
    } catch (err) {
      console.error("Error processing Horizon event stream", err);
    }
  };

  es.onerror = (err) => {
    console.error("Horizon SSE error, attempting reconnect", err);
    setTimeout(() => startEventSubscription(), 5000);
  };
}
