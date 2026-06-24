export const meta = {
  name: 'review-dimensions',
  description: 'Fan out code-reviewer agents, one per dimension, in parallel',
  phases: [{ title: 'Review' }],
}

const FINDING_SCHEMA = {
  type: 'object',
  required: ['dimension', 'findings', 'summary'],
  properties: {
    dimension: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'severity', 'type', 'description', 'suggestion'],
        properties: {
          file:        { type: 'string' },
          line:        { type: 'number' },
          severity:    { enum: ['blocking', 'advisory'] },
          type:        { type: 'string' },
          description: { type: 'string' },
          suggestion:  { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const { worktree_path, base_branch, branch, files_changed, test_command, project_root, plan_dir } = args

const DIMENSIONS = [
  { id: 'correctness',   label: 'Correctness / logic bugs' },
  { id: 'security',      label: 'Security' },
  { id: 'quality',       label: 'Code quality' },
  { id: 'test_coverage', label: 'Test coverage' },
]

const results = (await parallel(DIMENSIONS.map(dim => () =>
  agent(
    `Review the code changes for dimension: ${dim.id}\n\n` +
    `worktree_path: ${worktree_path}\n` +
    `base_branch: ${base_branch}\n` +
    `branch: ${branch}\n` +
    `files_changed: ${JSON.stringify(files_changed)}\n` +
    `test_command: ${test_command || ''}\n` +
    `project_root: ${project_root}\n` +
    `plan_dir: ${plan_dir}\n\n` +
    `Run git diff to see what changed, read the changed files, run your dimension-specific checks, and return only the structured result.`,
    {
      label: `review:${dim.id}`,
      phase: 'Review',
      agentType: 'ai-lore:code-reviewer',
      schema: FINDING_SCHEMA,
    }
  )
))).filter(Boolean)

return results
