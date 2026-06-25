export const meta = {
  name: 'brainstorm-adversary',
  description: 'Fan out brainstorm-adversary agents across three adversarial critique modes in parallel',
  phases: [{ title: 'Adversarial Review' }],
}

const ADVERSARY_SCHEMA = {
  type: 'object',
  required: ['mode', 'findings', 'summary'],
  properties: {
    mode: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['files_involved', 'severity', 'description', 'implication', 'suggestion'],
        properties: {
          files_involved: { type: 'array', items: { type: 'string' } },
          severity:       { enum: ['blocking', 'advisory'] },
          description:    { type: 'string' },
          implication:    { type: 'string' },
          suggestion:     { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const { brainstorm_dir } = args

const MODES = [
  { id: 'contradictions', label: 'Contradictions' },
  { id: 'assumptions',    label: 'False Assumptions' },
  { id: 'failure_modes',  label: 'Failure Modes' },
]

const results = (await parallel(MODES.map(m => () =>
  agent(
    `Adversarially review the brainstorm using mode: ${m.id}\n\n` +
    `brainstorm_dir: ${brainstorm_dir}\n\n` +
    `Read all markdown files in the brainstorm directory and return structured adversarial findings only.`,
    {
      label: `adversary:${m.id}`,
      phase: 'Adversarial Review',
      agentType: 'ai-lore:brainstorm-adversary',
      schema: ADVERSARY_SCHEMA,
    }
  )
))).filter(Boolean)

return results
