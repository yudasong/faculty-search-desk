import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const records = sqliteTable('records', {
 id: text('id').primaryKey(), kind: text('kind').notNull(), data: text('data').notNull(), revision: integer('revision').notNull().default(1), updatedAt: text('updated_at').notNull()
}, t => [index('idx_records_kind').on(t.kind)]);
