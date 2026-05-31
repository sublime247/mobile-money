import { pool, queryRead, queryWrite } from "../config/database";

export type DestinationType = "phone" | "stellar";

export interface UserContact {
  id: string;
  userId: string;
  destinationType: DestinationType;
  destinationValue: string;
  nickname: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserContactInput {
  userId: string;
  destinationType: DestinationType;
  destinationValue: string;
  nickname: string;
}

export interface UpdateUserContactInput {
  destinationType?: DestinationType;
  destinationValue?: string;
  nickname?: string;
}

function mapRow(row: any): UserContact {
  return {
    id: row.id,
    userId: row.user_id,
    destinationType: row.destination_type,
    destinationValue: row.destination_value,
    nickname: row.nickname,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ContactModel {
  async create(input: CreateUserContactInput): Promise<UserContact> {
    const result = await queryWrite(
      `INSERT INTO user_contacts (user_id, destination_type, destination_value, nickname)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, destination_type, destination_value, nickname, created_at, updated_at`,
      [
        input.userId,
        input.destinationType,
        input.destinationValue,
        input.nickname,
      ],
    );

    return mapRow(result.rows[0]);
  }

  async listByUser(userId: string): Promise<UserContact[]> {
    const result = await queryRead(
      `SELECT id, user_id, destination_type, destination_value, nickname, created_at, updated_at
       FROM user_contacts
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    );

    return result.rows.map(mapRow);
  }

  async findByIdForUser(
    id: string,
    userId: string,
  ): Promise<UserContact | null> {
    const result = await queryRead(
      `SELECT id, user_id, destination_type, destination_value, nickname, created_at, updated_at
       FROM user_contacts
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [id, userId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return mapRow(result.rows[0]);
  }

  async updateByIdForUser(
    id: string,
    userId: string,
    input: UpdateUserContactInput,
  ): Promise<UserContact | null> {
    const updates: string[] = [];
    const values: unknown[] = [id, userId];

    if (input.destinationType !== undefined) {
      values.push(input.destinationType);
      updates.push(`destination_type = $${values.length}`);
    }

    if (input.destinationValue !== undefined) {
      values.push(input.destinationValue);
      updates.push(`destination_value = $${values.length}`);
    }

    if (input.nickname !== undefined) {
      values.push(input.nickname);
      updates.push(`nickname = $${values.length}`);
    }

    if (updates.length === 0) {
      return this.findByIdForUser(id, userId);
    }

    const result = await queryWrite(
      `UPDATE user_contacts
       SET ${updates.join(", ")}
       WHERE id = $1 AND user_id = $2
       RETURNING id, user_id, destination_type, destination_value, nickname, created_at, updated_at`,
      values,
    );

    if (result.rows.length === 0) {
      return null;
    }

    return mapRow(result.rows[0]);
  }

  async deleteByIdForUser(id: string, userId: string): Promise<boolean> {
    const result = await queryWrite(
      `DELETE FROM user_contacts
       WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );

    return (result.rowCount ?? 0) > 0;
  }
}
