export const meta = {
  name: 'synthesize-docs',
  description: 'Run overview and dependency synthesis agents in parallel after module docs are on disk',
  phases: [{ title: 'Synthesize' }],
}

const SYNTH_SCHEMA = {
  type: 'object',
  required: ['content'],
  properties: {
    content: { type: 'string' },
  },
}

const { docs_dir, head_commit, run_date, scopes } = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {}
log(`docs_dir: ${docs_dir ?? '(undefined -- args not passed correctly)'}`)

const [overview, deps] = await parallel([
  () => agent(
    `You are producing the architecture overview document (overview.md).\n` +
    `type: overview\n` +
    `docs_dir: ${docs_dir}\n` +
    `head_commit: ${head_commit}\n` +
    `run_date: ${run_date}\n` +
    `scopes: ${JSON.stringify(scopes)}\n\n` +
    `Read all .md files in ${docs_dir}/modules/, then synthesize overview.md content. Return structured output only.`,
    {
      label: 'synthesize:overview',
      phase: 'Synthesize',
      agentType: 'ai-lore:docs-synthesizer',
      schema: SYNTH_SCHEMA,
    }
  ),
  () => agent(
    `You are producing the dependency map document (dependencies.md).\n` +
    `type: dependencies\n` +
    `docs_dir: ${docs_dir}\n` +
    `head_commit: ${head_commit}\n` +
    `run_date: ${run_date}\n` +
    `scopes: ${JSON.stringify(scopes)}\n\n` +
    `Read all .md files in ${docs_dir}/modules/, then synthesize dependencies.md content. Return structured output only.`,
    {
      label: 'synthesize:dependencies',
      phase: 'Synthesize',
      agentType: 'ai-lore:docs-synthesizer',
      schema: SYNTH_SCHEMA,
    }
  ),
])

return { overview_content: overview ? overview.content : '', deps_content: deps ? deps.content : '' }
