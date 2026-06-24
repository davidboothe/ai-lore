export const meta = {
  name: 'build-wave',
  description: 'Build one wave of a plan: parallel sub-agents, one per atomic task',
  phases: [{ title: 'Build' }],
}

const TASKS = args.tasks   // [{ id, file, isolation }] for the current wave

const RETURN = {
  type: 'object',
  required: ['task_id', 'outcome', 'ac', 'files_changed', 'summary'],
  properties: {
    task_id: { type: 'string' },
    outcome: { enum: ['complete', 'blocked'] },
    ac: { type: 'array', items: { type: 'object',
      required: ['criterion', 'pass'],
      properties: { criterion: { type: 'string' }, pass: { type: 'boolean' }, evidence: { type: 'string' } } } },
    files_changed: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    blocker: { type: 'string' },
  },
}

const results = (await parallel(TASKS.map(t => () =>
  agent(
    `Execute the ai-lore task at ${t.file}. Read it, implement every todo, self-check every AC, and return the structured result only.`,
    { label: `task:${t.id}`, phase: 'Build', agentType: 'ai-lore:task-executor', schema: RETURN,
      ...(t.isolation === 'worktree' ? { isolation: 'worktree' } : {}) }
  )
))).filter(Boolean)

return results
