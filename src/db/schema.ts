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
  created_by_agent: string | null;
  status: 'active' | 'superseded' | 'stale' | 'archived';
  importance: number;
  confidence: number;
  source_type: string | null;
  source_ref: string | null;
  valid_from: string | null;
  valid_until: string | null;
  supersedes_id: string | null;
  last_verified_at: string | null;
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
  created_by_agent: string | null;
  assigned_agent_id: string | null;
  required_capabilities: string | null;
  claimed_by_agent: string | null;
  claimed_at: string | null;
  blocker: string | null;
  progress: number;
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
  agent_id: string | null;
  provider: string | null;
  model: string | null;
  client: string | null;
  client_session_id: string | null;
}

export interface Agent {
  id: string;
  display_name: string;
  provider: string | null;
  model: string | null;
  client: string | null;
  client_version: string | null;
  capabilities: string | null;
  metadata: string | null;
  status: 'active' | 'paused' | 'retired';
  created_at: string;
  updated_at: string;
}

export interface MemoryFeedback {
  id: string;
  memory_id: string;
  agent_id: string | null;
  session_id: string | null;
  rating: 'used' | 'not_used' | 'helpful' | 'irrelevant' | 'stale' | 'incorrect' | 'too_verbose';
  notes: string | null;
  created_at: string;
}

export interface Experiment {
  id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  scenario: string;
  status: 'active' | 'completed' | 'cancelled';
  target_runs: number;
  created_at: string;
  updated_at: string;
}

export interface UsageReport {
  id: string;
  project_id: string | null;
  session_id: string | null;
  experiment_id: string | null;
  variant: 'without_hub' | 'with_hub' | null;
  provider: string | null;
  model: string | null;
  client: string | null;
  measurement: 'exact' | 'estimated';
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  hub_llm_input_tokens: number;
  hub_llm_output_tokens: number;
  context_tokens: number | null;
  context_chars: number | null;
  tool_calls: number | null;
  files_read: string | null;
  repeated_files: number | null;
  clarification_count: number | null;
  duration_ms: number | null;
  result_quality: number | null;
  success: number | null;
  notes: string | null;
  created_at: string;
  agent_id: string | null;
}
