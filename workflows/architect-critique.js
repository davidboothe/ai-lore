export const meta = {
  name: 'architect-critique',
  description: 'Fan out architect-adversary and architect-reviewer agents in parallel across all critique modes and reviewer perspectives',
  phases: [{ title: 'Architecture Critique' }],
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

const { architecture_dir, project_root } = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {}
log(`architecture_dir: ${architecture_dir ?? '(undefined -- args not passed correctly)'}`)

const MODES = [
  { id: 'contradictions', label: 'Contradictions' },
  { id: 'assumptions',    label: 'False Assumptions' },
  { id: 'failure_modes',  label: 'Failure Modes' },
]

const PERSPECTIVES = [
  { id: 'scalability',  label: 'Scalability' },
  { id: 'security',     label: 'Security' },
  { id: 'simplicity',   label: 'Simplicity' },
  { id: 'consistency',  label: 'Consistency' },
  { id: 'testability',  label: 'Testability' },
]

const results = (await parallel([
  ...MODES.map(m => () =>
    agent(
      `Adversarially critique the architecture using mode: ${m.id}\n\n` +
      `architecture_dir: ${architecture_dir}\n\n` +
      `Read all markdown files in the architecture directory and return structured adversarial findings only.`,
      {
        label: `adversary:${m.id}`,
        phase: 'Architecture Critique',
        agentType: 'ai-lore:architect-adversary',
        schema: ADVERSARY_SCHEMA,
      }
    )
  ),
  ...PERSPECTIVES.map(p => () =>
    agent(
      `Review the architecture from the perspective of: ${p.id}\n\n` +
      `architecture_dir: ${architecture_dir}\n` +
      `project_root: ${project_root}\n\n` +
      `Read all markdown files in the architecture directory and return structured findings from your perspective only.`,
      {
        label: `panel:${p.id}`,
        phase: 'Architecture Critique',
        agentType: 'ai-lore:architect-reviewer',
        schema: PANEL_SCHEMA,
      }
    )
  ),
])).filter(Boolean)

return {
  adversary: results.filter(r => r.mode),
  panel:     results.filter(r => r.perspective),
}
