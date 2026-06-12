export interface Project {
  id: string;
  name: string;
  root_path: string;
  stack: string | null;
  status: 'active' | 'paused' | 'archived';
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryNode {
  id: string;
  project_id: string | null;
  surface: string;
  name: string;
  description: string | null;
  type: 'user' | 'feedback' | 'project' | 'reference' | 'handoff' | 'decision';
  body: string;
  tags: string | null;
  origin_session: string | null;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_id: string | null;
  title: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
  priority: number;
  created_by: string;
  assigned_to: string | null;
  context_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface Session {
  id: string;
  project_id: string | null;
  surface: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  files_touched: string | null;
  commits_made: string | null;
  outcome: string | null;
}
