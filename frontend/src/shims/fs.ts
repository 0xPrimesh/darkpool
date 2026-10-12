// Browser stub for node:fs. @arcium-hq/client only touches fs in uploadCircuit.
const fs = {
  readFileSync() {
    throw new Error("fs is not available in the browser");
  },
};
export default fs;
