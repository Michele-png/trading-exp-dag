# User journey

## Register a space

The user creates a space in the Web UI or with `qdag spaces create`. The API
creates the space and its unique objective root in one transaction. The
response returns both identifiers, so later work never needs to infer a root.

## Preregister an experiment

`qdag experiments create` submits the hypothesis, method, success criteria,
space, and one or more lineage parents. The API returns a draft experiment.
When results already exist, the CLI marks the record retrospective rather than
silently presenting it as preregistered.

## Run a local test

`qdag run --experiment ID --result result.json -- <command>`:

1. captures safe Git and environment provenance;
2. opens an idempotent run record;
3. executes the command locally;
4. validates the versioned result manifest;
5. submits metrics, narrative, and artifact references; and
6. completes or fails the run while preserving the child exit code.

The server never executes the command.

## Interpret and connect evidence

The user reviews structured metrics and evidence in the node inspector. They
add explicit `supports`, `contradicts`, or `replicates` links. The product does
not infer these claims.

## Finalize

Finalization checks root reachability, required provenance, and revision state.
The frozen revision remains auditable. Editorial corrections append a
revision; a changed scientific claim is registered as a new child experiment.

## Explore

The Web UI presents a topological DAG. Overview mode shows the full space,
while focus mode restricts the canvas to selected ancestors and descendants.
Search and filters use the same server contract as the CLI.

## Preserve

`qdag backup` downloads a versioned export and optional private artifacts into
an authenticated encrypted bundle. `qdag restore` validates paths and
checksums before importing into an empty destination.
