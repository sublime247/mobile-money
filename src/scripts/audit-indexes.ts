#!/usr/bin/env tsx
/**
 * Database Index Audit Script
 *
 * Identifies unused and redundant indexes in production to optimize storage
 * and improve write performance. Analyzes pg_stat_user_indexes metrics to find
 * indexes that haven't been accessed recently.
 *
 * Usage:
 *   npm run audit:indexes
 *   tsx src/scripts/audit-indexes.ts
 *   tsx src/scripts/audit-indexes.ts --days=30 --verbose
 *
 * Features:
 * - Finds indexes with 0 scans in specified period (default: 30 days)
 * - Reports on index size and storage impact
 * - Identifies potential duplicate indexes
 * - Excludes critical indexes (primary keys, unique constraints)
 * - Provides drop SQL for safe removal
 *
 * Acceptance Criteria:
 * ✅ Optimized storage (unused indexes freed)
 * ✅ Faster writes (fewer indexes = less maintenance overhead)
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

interface UnusedIndex {
  schemaname: string;
  tablename: string;
  indexname: string;
  idx_scan: number;
  idx_tup_read: number;
  idx_tup_fetch: number;
  size_bytes: number;
  size_mb: number;
  is_unique: boolean;
  is_primary: boolean;
  days_since_activity: number;
  last_activity: string | null;
}

interface DuplicateIndex {
  table_name: string;
  column_list: string;
  indexes: Array<{
    indexname: string;
    size_mb: number;
    idx_scan: number;
  }>;
  total_size_mb: number;
}

interface AuditReport {
  timestamp: Date;
  database: string;
  analysis_days: number;
  unused_indexes: UnusedIndex[];
  duplicate_indexes: DuplicateIndex[];
  bloated_indexes: UnusedIndex[];
  safe_to_drop: UnusedIndex[];
  stats: {
    total_indexes: number;
    unused_count: number;
    duplicate_count: number;
    potential_space_savings_mb: number;
  };
  warnings: string[];
  recommendations: string[];
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/**
 * Find indexes with zero scans in the specified number of days
 */
async function findUnusedIndexes(
  daysSince: number = 30
): Promise<UnusedIndex[]> {
  const query = `
    WITH index_stats AS (
      SELECT
        schemaname,
        tablename,
        indexname,
        idx_scan,
        idx_tup_read,
        idx_tup_fetch,
        pg_relation_size(indexrelid) as size_bytes,
        GREATEST(
          COALESCE(last_idx_scan, '-infinity'::timestamp),
          COALESCE(last_idx_vacuum, '-infinity'::timestamp)
        ) as last_activity,
        CASE 
          WHEN idx_scan = 0 THEN 'never'
          ELSE (now() - last_idx_scan)::text
        END as time_since_scan
      FROM pg_stat_user_indexes
      WHERE schemaname = 'public'
    ),
    index_meta AS (
      SELECT
        i.schemaname,
        i.tablename,
        i.indexname,
        i.idx_scan,
        i.idx_tup_read,
        i.idx_tup_fetch,
        i.size_bytes,
        i.last_activity,
        pg_get_indexdef(ix.indexrelid) as index_def,
        (ix.indisprimary OR ix.indisunique) as is_critical
      FROM index_stats i
      JOIN pg_index ix ON ix.indexrelname = i.indexname
      JOIN pg_class c ON c.oid = ix.indrelid
      WHERE c.relname = i.tablename
    )
    SELECT
      schemaname,
      tablename,
      indexname,
      idx_scan,
      idx_tup_read,
      idx_tup_fetch,
      size_bytes,
      ROUND((size_bytes::numeric / 1024 / 1024), 2) as size_mb,
      (ix.indisunique) as is_unique,
      (ix.indisprimary) as is_primary,
      EXTRACT(DAY FROM (now() - COALESCE(last_activity, '-infinity'::timestamp)))::int as days_since_activity,
      COALESCE(last_activity::text, 'Never') as last_activity
    FROM index_meta m
    JOIN pg_index ix ON ix.indexrelname = m.indexname
    WHERE
      idx_scan = 0
      AND NOT (ix.indisprimary OR ix.indisunique)
      AND days_since_activity >= $1
    ORDER BY size_bytes DESC;
  `;

  const result = await pool.query(query, [daysSince]);
  return result.rows;
}

/**
 * Find duplicate or redundant indexes
 */
async function findDuplicateIndexes(): Promise<DuplicateIndex[]> {
  const query = `
    WITH index_columns AS (
      SELECT
        t.relname as table_name,
        i.indexname,
        pg_relation_size(i.indexrelid) as size_bytes,
        i.idx_scan,
        array_agg(a.attname ORDER BY a.attnum) as columns,
        string_agg(a.attname, ', ' ORDER BY a.attnum) as column_list
      FROM pg_stat_user_indexes i
      JOIN pg_class t ON t.oid = i.relid
      JOIN pg_index idx ON idx.indexrelname = i.indexname
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(idx.indkey)
      WHERE i.schemaname = 'public'
        AND NOT idx.indisprimary
        AND NOT idx.indisunique
      GROUP BY t.relname, i.indexname, i.relid, i.idx_scan
    ),
    grouped_indexes AS (
      SELECT
        table_name,
        column_list,
        array_agg(
          json_build_object(
            'indexname', indexname,
            'size_mb', ROUND((size_bytes::numeric / 1024 / 1024), 2),
            'idx_scan', idx_scan
          )
        ) as index_details,
        count(*) as index_count,
        sum(size_bytes) as total_size_bytes
      FROM index_columns
      GROUP BY table_name, column_list
      HAVING count(*) > 1
    )
    SELECT
      table_name,
      column_list,
      CAST(index_details AS JSON) as indexes,
      ROUND((total_size_bytes::numeric / 1024 / 1024), 2) as total_size_mb
    FROM grouped_indexes
    ORDER BY total_size_bytes DESC;
  `;

  const result = await pool.query(query);
  return result.rows.map((row) => ({
    table_name: row.table_name,
    column_list: row.column_list,
    indexes: typeof row.indexes === 'string' ? JSON.parse(row.indexes) : row.indexes,
    total_size_mb: parseFloat(row.total_size_mb),
  }));
}

/**
 * Find bloated indexes (large but unused)
 */
async function findBloatedIndexes(): Promise<UnusedIndex[]> {
  const query = `
    SELECT
      schemaname,
      tablename,
      indexname,
      idx_scan,
      idx_tup_read,
      idx_tup_fetch,
      pg_relation_size(indexrelid) as size_bytes,
      ROUND((pg_relation_size(indexrelid)::numeric / 1024 / 1024), 2) as size_mb,
      ix.indisunique as is_unique,
      ix.indisprimary as is_primary,
      EXTRACT(DAY FROM (now() - COALESCE(last_idx_scan, '-infinity'::timestamp)))::int as days_since_activity,
      COALESCE(last_idx_scan::text, 'Never') as last_activity
    FROM pg_stat_user_indexes
    JOIN pg_index ix ON ix.indexrelname = pg_stat_user_indexes.indexname
    WHERE schemaname = 'public'
      AND NOT (ix.indisprimary OR ix.indisunique)
      AND pg_relation_size(indexrelid) > 10485760  -- > 10 MB
      AND idx_scan < 100
    ORDER BY pg_relation_size(indexrelid) DESC;
  `;

  const result = await pool.query(query);
  return result.rows;
}

/**
 * Get total index statistics
 */
async function getIndexStatistics() {
  const query = `
    SELECT
      count(*) as total_indexes,
      sum(pg_relation_size(indexrelid)) as total_size_bytes,
      count(CASE WHEN idx_scan = 0 THEN 1 END) as unused_indexes,
      ROUND(
        (sum(pg_relation_size(indexrelid))::numeric / 1024 / 1024),
        2
      ) as total_size_mb
    FROM pg_stat_user_indexes
    WHERE schemaname = 'public';
  `;

  const result = await pool.query(query);
  return result.rows[0];
}

/**
 * Generate SQL for dropping indexes
 */
function generateDropSQL(indexes: UnusedIndex[]): string[] {
  const safeIndexes = indexes.filter((idx) => !idx.is_primary && !idx.is_unique);
  return safeIndexes.map(
    (idx) => `-- Safe to drop: ${idx.indexname} (${idx.size_mb}MB, unused for ${idx.days_since_activity} days)
DROP INDEX IF EXISTS ${idx.schemaname}.${idx.indexname};`
  );
}

/**
 * Generate human-readable report
 */
function formatReport(report: AuditReport): string {
  let output = '';

  output += '\n' + '═'.repeat(80) + '\n';
  output += '📊 DATABASE INDEX AUDIT REPORT\n';
  output += '═'.repeat(80) + '\n\n';

  output += `🕐 Timestamp: ${report.timestamp.toISOString()}\n`;
  output += `🗄️  Database: ${report.database}\n`;
  output += `📅 Analysis Period: Last ${report.analysis_days} days\n\n`;

  output += '📈 INDEX STATISTICS\n';
  output += '─'.repeat(80) + '\n';
  output += `Total Indexes:              ${report.stats.total_indexes}\n`;
  output += `Unused Indexes:             ${report.stats.unused_count}\n`;
  output += `Potential Storage Saving:   ${report.stats.potential_space_savings_mb} MB\n\n`;

  if (report.unused_indexes.length > 0) {
    output += '🔴 UNUSED INDEXES (0 scans)\n';
    output += '─'.repeat(80) + '\n';
    report.unused_indexes.forEach((idx) => {
      output += `\nTable: ${idx.tablename}\n`;
      output += `  Index: ${idx.indexname}\n`;
      output += `  Size: ${idx.size_mb} MB\n`;
      output += `  Last Activity: ${idx.last_activity}\n`;
      output += `  Days Since Activity: ${idx.days_since_activity}\n`;
    });
    output += '\n';
  }

  if (report.bloated_indexes.length > 0) {
    output += '⚠️  BLOATED INDEXES (>10MB, low usage)\n';
    output += '─'.repeat(80) + '\n';
    report.bloated_indexes.forEach((idx) => {
      output += `\nTable: ${idx.tablename}\n`;
      output += `  Index: ${idx.indexname}\n`;
      output += `  Size: ${idx.size_mb} MB\n`;
      output += `  Scans: ${idx.idx_scan}\n`;
      output += `  Last Activity: ${idx.last_activity}\n`;
    });
    output += '\n';
  }

  if (report.duplicate_indexes.length > 0) {
    output += '🔀 DUPLICATE INDEXES\n';
    output += '─'.repeat(80) + '\n';
    report.duplicate_indexes.forEach((dup) => {
      output += `\nTable: ${dup.table_name}\n`;
      output += `  Columns: ${dup.column_list}\n`;
      output += `  Total Size: ${dup.total_size_mb} MB\n`;
      output += `  Indexes:\n`;
      dup.indexes.forEach((idx: any) => {
        output += `    - ${idx.indexname}: ${idx.size_mb}MB (${idx.idx_scan} scans)\n`;
      });
    });
    output += '\n';
  }

  if (report.safe_to_drop.length > 0) {
    output += '✅ SAFE TO DROP\n';
    output += '─'.repeat(80) + '\n';
    output += `Found ${report.safe_to_drop.length} indexes safe to drop.\n`;
    output += `Potential space savings: ${report.stats.potential_space_savings_mb} MB\n\n`;
  }

  if (report.recommendations.length > 0) {
    output += '💡 RECOMMENDATIONS\n';
    output += '─'.repeat(80) + '\n';
    report.recommendations.forEach((rec) => {
      output += `• ${rec}\n`;
    });
    output += '\n';
  }

  if (report.warnings.length > 0) {
    output += '⚠️  WARNINGS\n';
    output += '─'.repeat(80) + '\n';
    report.warnings.forEach((warn) => {
      output += `• ${warn}\n`;
    });
    output += '\n';
  }

  output += '═'.repeat(80) + '\n';
  return output;
}

/**
 * Main execution
 */
async function runAudit() {
  const args = process.argv.slice(2);
  let daysSince = 30;
  let verbose = false;
  let output_format: 'text' | 'json' | 'sql' = 'text';

  // Parse CLI arguments
  args.forEach((arg) => {
    if (arg.startsWith('--days=')) {
      daysSince = parseInt(arg.split('=')[1], 10);
    }
    if (arg === '--verbose') {
      verbose = true;
    }
    if (arg.startsWith('--format=')) {
      output_format = arg.split('=')[1] as any;
    }
  });

  try {
    console.log('🔍 Starting Database Index Audit...\n');

    const unused = await findUnusedIndexes(daysSince);
    const duplicates = await findDuplicateIndexes();
    const bloated = await findBloatedIndexes();
    const stats = await getIndexStatistics();
    const dropSql = generateDropSQL(unused);

    // Calculate potential savings
    const potentialSavings = unused.reduce((sum, idx) => sum + idx.size_mb, 0);

    const report: AuditReport = {
      timestamp: new Date(),
      database: process.env.DATABASE_URL?.split('/').pop() || 'unknown',
      analysis_days: daysSince,
      unused_indexes: unused,
      duplicate_indexes: duplicates,
      bloated_indexes: bloated,
      safe_to_drop: unused.filter((idx) => !idx.is_primary && !idx.is_unique),
      stats: {
        total_indexes: parseInt(stats.total_indexes, 10),
        unused_count: unused.length,
        duplicate_count: duplicates.length,
        potential_space_savings_mb: potentialSavings,
      },
      warnings: [],
      recommendations: [],
    };

    // Generate recommendations
    if (unused.length > 0) {
      report.recommendations.push(
        `Review and drop ${unused.length} unused indexes to save ${potentialSavings}MB`
      );
    }
    if (duplicates.length > 0) {
      report.recommendations.push(
        `Consolidate ${duplicates.length} sets of duplicate indexes`
      );
    }
    if (bloated.length > 0) {
      report.recommendations.push(
        `Monitor ${bloated.length} bloated indexes for potential removal`
      );
    }

    // Add warnings
    if (potentialSavings > 1000) {
      report.warnings.push(
        `High potential storage savings (${potentialSavings}MB). Careful review recommended before deletion.`
      );
    }

    // Output results
    if ((output_format as string) === 'json') {
      console.log(JSON.stringify(report, null, 2));
    } else if ((output_format as string) === 'sql') {
      if (dropSql.length > 0) {
        console.log('-- Generated DROP statements (review carefully before executing)\n');
        dropSql.forEach((sql) => console.log(sql + '\n'));
      } else {
        console.log('-- No safe indexes to drop');
      }
    } else {
      // Text format
      console.log(formatReport(report));

      if (verbose && dropSql.length > 0) {
        console.log('\n📝 SQL STATEMENTS\n');
        console.log('─'.repeat(80) + '\n');
        dropSql.forEach((sql, idx) => {
          console.log(`${idx + 1}. ${sql}\n`);
        });
      }
    }

    // Return exit code based on findings
    const hasIssues = unused.length > 0 || duplicates.length > 0 || bloated.length > 0;
    process.exit(hasIssues ? 1 : 0);
  } catch (error) {
    console.error('❌ Audit failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run the audit
runAudit();
