import { windowBounds } from "../src/lib/allocation/service";
const now = new Date();
console.log(now.toISOString(), windowBounds(now));
