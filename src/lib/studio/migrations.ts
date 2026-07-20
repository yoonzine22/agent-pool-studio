import type { Migration } from '../migrations'
import { z } from 'zod'

const tableInfoSchema = z.array(z.object({ name: z.string() }))

export const agentStudioMigrations: Migration[] = [
  {
    id: '055_agent_pool_studio',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_teams (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(workspace_id, name),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_team_members (
          team_id INTEGER NOT NULL,
          agent_id INTEGER NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (team_id, agent_id),
          FOREIGN KEY (team_id) REFERENCES agent_teams(id) ON DELETE CASCADE,
          FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_workflows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL,
          team_id INTEGER,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          nodes TEXT NOT NULL,
          edges TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE(workspace_id, name),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (team_id) REFERENCES agent_teams(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS agent_workflow_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL,
          workflow_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          input TEXT NOT NULL DEFAULT '',
          node_states TEXT NOT NULL,
          workflow_snapshot TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          error TEXT,
          cancellation_requested_at INTEGER,
          started_at INTEGER,
          completed_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (workflow_id) REFERENCES agent_workflows(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_workflow_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL,
          run_id INTEGER NOT NULL,
          node_id TEXT,
          event_type TEXT NOT NULL,
          message TEXT NOT NULL,
          data TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (run_id) REFERENCES agent_workflow_runs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_agent_teams_workspace ON agent_teams(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_agent_workflows_workspace ON agent_workflows(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_agent_workflow_runs_workspace ON agent_workflow_runs(workspace_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_workflow_events_run ON agent_workflow_events(run_id, id);
      `)
    },
  },
  {
    id: '056_agent_workflow_run_snapshots',
    up: (db) => {
      const columns = tableInfoSchema.parse(db.pragma('table_info(agent_workflow_runs)'))
      if (!columns.some((column) => column.name === 'workflow_snapshot')) {
        db.exec('ALTER TABLE agent_workflow_runs ADD COLUMN workflow_snapshot TEXT')
      }
      if (!columns.some((column) => column.name === 'cancellation_requested_at')) {
        db.exec('ALTER TABLE agent_workflow_runs ADD COLUMN cancellation_requested_at INTEGER')
      }
      db.exec(`
        UPDATE agent_workflow_runs
        SET workflow_snapshot = (
          SELECT json_object(
            'id', workflow.id,
            'workspaceId', workflow.workspace_id,
            'teamId', workflow.team_id,
            'name', workflow.name,
            'description', workflow.description,
            'nodes', json(workflow.nodes),
            'edges', json(workflow.edges),
            'createdAt', strftime('%Y-%m-%dT%H:%M:%fZ', workflow.created_at, 'unixepoch'),
            'updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', workflow.updated_at, 'unixepoch')
          )
          FROM agent_workflows AS workflow
          WHERE workflow.id = agent_workflow_runs.workflow_id
        )
        WHERE workflow_snapshot IS NULL OR trim(workflow_snapshot) = ''
      `)
      const missingSnapshots = z.object({ count: z.number().int().nonnegative() }).parse(
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM agent_workflow_runs
          WHERE workflow_snapshot IS NULL OR trim(workflow_snapshot) = ''
        `).get(),
      )
      if (missingSnapshots.count > 0) {
        throw new Error('Cannot migrate Agent Studio runs without their referenced workflows')
      }
    },
  },
  {
    id: '057_agent_workflow_run_cancellation',
    up: (db) => {
      const columns = tableInfoSchema.parse(db.pragma('table_info(agent_workflow_runs)'))
      if (!columns.some((column) => column.name === 'cancellation_requested_at')) {
        db.exec('ALTER TABLE agent_workflow_runs ADD COLUMN cancellation_requested_at INTEGER')
      }
    },
  },
  {
    id: '058_agent_workflow_runtime_processes',
    up: (db) => {
      db.exec(`
        CREATE TABLE agent_workflow_runtime_processes (
          ownership_token TEXT PRIMARY KEY,
          workspace_id INTEGER NOT NULL,
          run_id INTEGER NOT NULL,
          node_id TEXT NOT NULL,
          agent_id INTEGER NOT NULL,
          process_pid INTEGER,
          process_pgid INTEGER,
          process_started_at TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          CHECK (process_pid IS NULL OR process_pid > 0),
          CHECK (process_pgid IS NULL OR process_pgid > 0),
          CHECK ((process_pid IS NULL) = (process_pgid IS NULL)),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (run_id) REFERENCES agent_workflow_runs(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_agent_workflow_runtime_processes_run
          ON agent_workflow_runtime_processes(workspace_id, run_id);
        CREATE INDEX idx_agent_workflow_runtime_processes_agent
          ON agent_workflow_runtime_processes(workspace_id, agent_id);
      `)
    },
  },
]
