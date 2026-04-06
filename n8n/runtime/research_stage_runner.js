"use strict";

const { postFailure, runStage } = require("./research_runtime");

function decodeState(encoded) {
  if (!encoded) {
    throw new Error("Encoded workflow state is required.");
  }
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

async function main() {
  const stage = process.argv[2];
  const encodedState = process.argv[3];
  if (!stage) {
    throw new Error("Stage name is required.");
  }

  let state = null;
  try {
    state = decodeState(encodedState);
    const nextState = await runStage(stage, state);
    process.stdout.write(JSON.stringify(nextState));
  } catch (error) {
    await postFailure(state, error);
    console.error(error);
    process.exitCode = 1;
  }
}

main();
