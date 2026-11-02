/** Benchmark-only wrapper around the public bundled main; stdout is untouched. */
import {pathToFileURL} from 'node:url';
const {main}=await import(pathToFileURL(process.argv[2]).href);
await main(process.argv.slice(3));
process.stderr.write(JSON.stringify({benchmarkCliPeakRssMiB:Math.round(process.resourceUsage().maxRSS/1024),benchmarkCliFinalRssMiB:Math.round(process.memoryUsage().rss/1048576)})+'\n');
