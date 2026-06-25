export const meta = {
  name: 'ai-lore-state-check',
  description: 'Read .ai-lore state: pending plans, active builds, cleanup-eligible and blocked runs',
  phases: [{ title: 'Read state' }],
}

const STATE_SCHEMA = {
  type: 'object',
  required: ['pending_plans', 'active_builds', 'cleanup_eligible', 'blocked_builds'],
  properties: {
    pending_plans: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'title', 'wave_count', 'task_count'],
        properties: {
          slug:       { type: 'string' },
          title:      { type: 'string' },
          wave_count: { type: 'number' },
          task_count: { type: 'number' },
        },
      },
    },
    active_builds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'branch', 'wave', 'of', 'tasks_done', 'tasks_total'],
        properties: {
          slug:        { type: 'string' },
          branch:      { type: 'string' },
          wave:        { type: 'number' },
          of:          { type: 'number' },
          tasks_done:  { type: 'number' },
          tasks_total: { type: 'number' },
        },
      },
    },
    cleanup_eligible: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'branch', 'base_branch'],
        properties: {
          slug:          { type: 'string' },
          branch:        { type: 'string' },
          base_branch:   { type: 'string' },
          pr_url:        { type: 'string' },
          review_status: { type: 'string' },
        },
      },
    },
    blocked_builds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'wave', 'of'],
        properties: {
          slug: { type: 'string' },
          wave: { type: 'number' },
          of:   { type: 'number' },
        },
      },
    },
  },
}

const state = await agent(
  'Read the .ai-lore directory in the current project and classify its state.\n\n' +
  '1. Read .ai-lore/runs.yaml if it exists. Parse its "runs" list.\n' +
  '2. Scan .ai-lore/plans/*/plan.md. For each, read the YAML frontmatter (title, status, wave count, task count).\n' +
  '3. Classify:\n' +
  '   - pending_plans: plan.md files whose frontmatter status is "pending" AND either have no entry in runs.yaml or their runs.yaml entry has status "pending". These have been planned but never built.\n' +
  '   - active_builds: runs.yaml entries with status "in_progress".\n' +
  '   - cleanup_eligible: runs.yaml entries with status "complete" and no pr_url (or pr_url is null/empty). For each, also include the review_status field from the runs.yaml entry if present (it may be "complete" or absent).\n' +
  '   - blocked_builds: runs.yaml entries with status "blocked".\n' +
  '4. If .ai-lore/plans/ does not exist or is empty, return empty arrays for all fields.\n' +
  'Return only the structured result.',
  { label: 'read-state', phase: 'Read state', schema: STATE_SCHEMA }
)
return state
