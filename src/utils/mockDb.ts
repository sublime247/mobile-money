export function createInMemoryDbMock() {
  const inMemoryTables = {
    users: new Map<string, any>(),
    vaults: new Map<string, any>(),
    transactions: new Map<string, any>(),
    aml_alerts: new Map<string, any>(),
    aml_alert_review_history: [] as any[],
  };

  const mockQuery = async (text: string, params?: any[]) => {
    const cleanText = text.replace(/\s+/g, " ").trim();

    if (cleanText.includes("INSERT INTO users")) {
      const [id, phone_number, kyc_level, mcc, profile_url] = params || [];
      for (const u of inMemoryTables.users.values()) {
        if (u.phone_number === phone_number) {
          throw new Error(`duplicate key value violates unique constraint "users_phone_number_key"`);
        }
      }
      const user = {
        id,
        phone_number,
        kyc_level,
        mcc: mcc || null,
        profile_url: profile_url || null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      inMemoryTables.users.set(id, user);
      return { rows: [user], rowCount: 1 };
    }

    if (cleanText.includes("FROM users WHERE id = $1")) {
      const id = params?.[0];
      const user = inMemoryTables.users.get(id);
      return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
    }

    if (cleanText.includes("FROM users WHERE phone_number = $1")) {
      const phone = params?.[0];
      for (const u of inMemoryTables.users.values()) {
        if (u.phone_number === phone) {
          return { rows: [u], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (cleanText.includes("UPDATE users SET kyc_level")) {
      const [id, kyc_level] = params || [];
      const user = inMemoryTables.users.get(id);
      if (!user) return { rows: [], rowCount: 0 };
      user.kyc_level = kyc_level;
      user.updated_at = new Date();
      return { rows: [user], rowCount: 1 };
    }

    if (cleanText.includes("INSERT INTO vaults")) {
      const [id, name, description, owner_id, balance, status] = params || [];
      if (!inMemoryTables.users.has(owner_id)) {
        throw new Error(`insert or update on table "vaults" violates foreign key constraint "vaults_owner_id_fkey"`);
      }
      const vault = {
        id,
        name,
        description: description || null,
        owner_id,
        balance: Number(balance),
        status,
        created_at: new Date(),
        updated_at: new Date(),
      };
      inMemoryTables.vaults.set(id, vault);
      return { rows: [vault], rowCount: 1 };
    }

    if (cleanText.includes("FROM vaults WHERE id = $1")) {
      const id = params?.[0];
      const vault = inMemoryTables.vaults.get(id);
      return { rows: vault ? [vault] : [], rowCount: vault ? 1 : 0 };
    }

    if (cleanText.includes("UPDATE vaults SET balance = balance + $2")) {
      const [id, delta] = params || [];
      const vault = inMemoryTables.vaults.get(id);
      if (!vault || vault.status === "locked") return { rows: [], rowCount: 0 };
      vault.balance += Number(delta);
      vault.updated_at = new Date();
      return { rows: [vault], rowCount: 1 };
    }

    if (cleanText.includes("UPDATE vaults SET status = $2")) {
      const [id, status] = params || [];
      const vault = inMemoryTables.vaults.get(id);
      if (!vault) return { rows: [], rowCount: 0 };
      vault.status = status;
      vault.updated_at = new Date();
      return { rows: [vault], rowCount: 1 };
    }

    if (cleanText.includes("INSERT INTO transactions")) {
      const [
        id,
        user_id,
        reference_number,
        type,
        amount,
        phone_number,
        provider,
        stellar_address,
        status,
        tags,
        metadata,
        vault_id,
      ] = params || [];

      if (!inMemoryTables.users.has(user_id)) {
        throw new Error(`insert or update on table "transactions" violates foreign key constraint "transactions_user_id_fkey"`);
      }
      for (const tx of inMemoryTables.transactions.values()) {
        if (tx.reference_number === reference_number && tx.user_id === user_id) {
          throw new Error(`duplicate key value violates unique constraint "transactions_reference_number_user_id_key"`);
        }
      }

      const tx = {
        id,
        user_id,
        reference_number,
        type,
        amount: Number(amount),
        phone_number,
        provider,
        stellar_address,
        status,
        tags: tags || [],
        metadata: typeof metadata === "string" ? JSON.parse(metadata) : metadata || {},
        vault_id: vault_id || null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      inMemoryTables.transactions.set(id, tx);
      return { rows: [tx], rowCount: 1 };
    }

    if (cleanText.includes("FROM transactions WHERE id = $1")) {
      const id = params?.[0];
      const tx = inMemoryTables.transactions.get(id);
      return { rows: tx ? [tx] : [], rowCount: tx ? 1 : 0 };
    }

    if (cleanText.includes("FROM transactions WHERE reference_number = $1")) {
      const ref = params?.[0];
      for (const tx of inMemoryTables.transactions.values()) {
        if (tx.reference_number === ref) {
          return { rows: [tx], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (cleanText.includes("UPDATE transactions SET status = $2")) {
      const [id, status] = params || [];
      const tx = inMemoryTables.transactions.get(id);
      if (!tx) return { rows: [], rowCount: 0 };
      tx.status = status;
      tx.updated_at = new Date();
      return { rows: [tx], rowCount: 1 };
    }

    if (cleanText.includes("INSERT INTO aml_alerts")) {
      const [id, transaction_id, user_id, severity, status, rule_hits, reasons] = params || [];
      if (!inMemoryTables.users.has(user_id)) {
        throw new Error(`insert on aml_alerts violates foreign key constraint "aml_alerts_user_id_fkey"`);
      }
      if (!inMemoryTables.transactions.has(transaction_id)) {
        throw new Error(`insert on aml_alerts violates foreign key constraint "aml_alerts_transaction_id_fkey"`);
      }
      const alert = {
        id,
        transaction_id,
        user_id,
        severity,
        status,
        rule_hits: typeof rule_hits === "string" ? JSON.parse(rule_hits) : rule_hits || [],
        reasons: reasons || [],
        reviewed_at: null,
        reviewed_by: null,
        review_notes: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      inMemoryTables.aml_alerts.set(id, alert);
      return { rows: [alert], rowCount: 1 };
    }

    if (cleanText.includes("FROM aml_alerts WHERE id = $1")) {
      const id = params?.[0];
      const alert = inMemoryTables.aml_alerts.get(id);
      return { rows: alert ? [alert] : [], rowCount: alert ? 1 : 0 };
    }

    if (cleanText.includes("UPDATE aml_alerts")) {
      const [id, status, reviewed_by, review_notes] = params || [];
      const alert = inMemoryTables.aml_alerts.get(id);
      if (!alert) return { rows: [], rowCount: 0 };
      alert.status = status;
      alert.reviewed_at = new Date();
      alert.reviewed_by = reviewed_by;
      alert.review_notes = review_notes || null;
      alert.updated_at = new Date();
      return { rows: [alert], rowCount: 1 };
    }

    if (cleanText.includes("INSERT INTO aml_alert_review_history")) {
      const [id, alert_id, user_id, previous_status, new_status, reviewed_by, review_notes] = params || [];
      const hist = {
        id,
        alert_id,
        user_id,
        previous_status,
        new_status,
        reviewed_by,
        review_notes: review_notes || null,
        created_at: new Date(),
      };
      inMemoryTables.aml_alert_review_history.push(hist);
      return { rows: [hist], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  return {
    mockQuery,
    inMemoryTables,
  };
}
