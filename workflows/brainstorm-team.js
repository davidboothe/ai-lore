export const meta = {
  name: 'brainstorm-team',
  description: 'Fan out brainstorm-panel agents, one per expert perspective, in parallel',
  phases: [{ title: 'Panel Review' }],
}

const PANEL_SCHEMA = {
  type: 'object',
  required: ['perspective', 'findings', 'open_questions', 'suggested_additions', 'summary'],
  properties: {
    perspective: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'severity', 'type', 'description', 'suggestion'],
        properties: {
          file:        { type: 'string' },
          severity:    { enum: ['blocking', 'advisory'] },
          type:        { type: 'string' },
          description: { type: 'string' },
          suggestion:  { type: 'string' },
        },
      },
    },
    open_questions:      { type: 'array', items: { type: 'string' } },
    suggested_additions: { type: 'array', items: { type: 'string' } },
    summary:             { type: 'string' },
  },
}

const { brainstorm_dir } = args

const PERSPECTIVES = [
  { id: 'product_manager', label: 'Product Manager' },
  { id: 'ux_advocate',     label: 'UX / User Advocate' },
  { id: 'architect',       label: 'Architect' },
  { id: 'security',        label: 'Security' },
  { id: 'qa',              label: 'QA / Edge Cases' },
]

const results = (await parallel(PERSPECTIVES.map(p => () =>
  agent(
    `Review the brainstorm from the perspective of: ${p.id}\n\n` +
    `brainstorm_dir: ${brainstorm_dir}\n\n` +
    `Read all markdown files in the brainstorm directory and return structured findings from your perspective only.`,
    {
      label: `panel:${p.id}`,
      phase: 'Panel Review',
      agentType: 'ai-lore:brainstorm-panel',
      schema: PANEL_SCHEMA,
    }
  )
))).filter(Boolean)

return results
