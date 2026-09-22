# Model service connections

OpenAgent separates the agent that executes work from an independently connected model service.

## Language

**Harness**: An agent runtime that owns execution, tools, permissions and native sessions. It also owns any subscription built into that runtime.

**Native subscription**: A model-service entitlement managed by a Harness's native account system. Its model catalog and quota belong to that native service.

**Provider**: An independently connectable model service with its own model identities and account capacity. A service remains a Provider when its connection is discovered in a Harness's native settings.

**Connection**: One configured relationship with a Provider, including its account credentials and applicable connection scope. Reusing a connection does not create an additional account budget.

**Connection scope**: The extent over which a connection applies, as supported by the chosen Harness and Provider configuration. It is not universally fixed to a Thread or Harness.

**Call identifier**: The model name sent to a model-service API. It may be a moving alias for a different model release over time.

**Model release**: The actual model version served behind a call identifier. Its identity is distinct from reasoning or effort configuration.

**Account telemetry**: Provider- or subscription-authored facts about available capacity, balance or usage. Missing facts mean unknown capacity.
