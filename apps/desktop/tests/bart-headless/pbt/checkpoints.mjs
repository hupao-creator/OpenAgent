import fc from 'fast-check'

/** A failed mandatory sequence enters the same isolated model runner as random commands. */
export function checkpointCommands(definition, index, coverage) {
  const plans = definition.checkpoints[index]
  if (!plans) throw new Error(`unknown ${definition.name} checkpoint ${index}`)
  return new FixedSequence(plans).map(value => new CheckpointCommands(value, definition, coverage))
}

/** Generate the known failure first; let fast-check shrink by removing steps. */
class FixedSequence extends fc.Arbitrary {
  constructor(plans) {
    super()
    this.plans = plans
    this.arrays = fc.array(fc.noShrink(fc.constantFrom(...plans)), { maxLength: plans.length })
  }

  generate() { return new fc.Value([...this.plans], undefined) }
  canShrinkWithoutContext(value) { return this.arrays.canShrinkWithoutContext(value) }
  shrink(value, context) { return this.arrays.shrink(value, context) }
}

class CheckpointCommands {
  constructor(plans, definition, coverage) {
    this.plans = plans
    this.definition = definition
    this.coverage = coverage
    this.commands = plans.map(plan => {
      const cmd = definition.commandFor(plan, coverage)
      return {
        hasRan: false,
        check: model => cmd.check(model),
        run(model, real) { this.hasRan = true; return cmd.run(model, real) },
        toString: () => cmd.toString()
      }
    })
  }

  [Symbol.iterator]() { return this.commands[Symbol.iterator]() }
  [fc.cloneMethod]() { return new CheckpointCommands(this.plans, this.definition, this.coverage) }
  toString() { return this.commands.filter(command => command.hasRan).join(',') }
}
