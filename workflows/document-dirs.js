export const meta = {
  name: 'document-dirs',
  description: 'Fan out directory-documenter agents, one per directory',
  phases: [{ title: 'Document directories' }],
}

const DIR_SCHEMA = {
  type: 'object',
  required: ['directory', 'summary', 'files', 'patterns', 'outbound_dependencies'],
  properties: {
    directory: { type: 'string' },
    summary: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'purpose'],
        properties: {
          path: { type: 'string' },
          purpose: { type: 'string' },
          exports: { type: 'array', items: { type: 'string' } },
          key_dependencies: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    patterns: { type: 'string' },
    outbound_dependencies: { type: 'array', items: { type: 'string' } },
  },
}

const { dirs, include_tests, head_commit } = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {}
log(`dirs: ${dirs ? dirs.length + ' directories' : '(undefined -- args not passed correctly)'}`)

const results = (await parallel(dirs.map(d => () =>
  agent(
    `Document directory "${d}" in this repo.\n` +
    `include_tests: ${include_tests}\n` +
    `head_commit: ${head_commit}\n\n` +
    `Read every source file directly in this directory (not recursively), ` +
    `document each one, and return structured output only.`,
    {
      label: `doc:${d}`,
      phase: 'Document directories',
      agentType: 'ai-lore:directory-documenter',
      schema: DIR_SCHEMA,
    }
  )
))).filter(Boolean)

return results
