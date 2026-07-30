const gatewayToken = process.argv.at(process.argv.indexOf("--token") + 1) ?? "missing-gateway-token";
process.stderr.write(`unlabelled gateway=${gatewayToken} model=${process.env.LONGHUB_MODEL_TOKEN ?? "missing-model-token"}`);
process.exit(1);
