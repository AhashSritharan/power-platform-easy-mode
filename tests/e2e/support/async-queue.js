// Tells a deployment that broke from one the environment never ran. Exports
// and imports are async jobs, and some days Dataverse leaves them queued for
// hours before a worker picks them up — measured: created 09:51, started 13:46,
// with the export itself taking seconds. The deploy tests skip on that rather
// than fail, so a red run still means the tool is wrong.

/**
 * The asyncoperations row (name, createdon, startedon) that waited longest for
 * a worker, if that wait reached `limitMs` — with its wait as `waitMs`. A job
 * still queued has waited until `now`.
 */
export function queueStall(jobs, { now = new Date(), limitMs }) {
    let longest = null;
    for (const job of jobs) {
        const waitMs = new Date(job.startedon ?? now) - new Date(job.createdon);
        if (waitMs >= limitMs && waitMs > (longest?.waitMs ?? -1)) longest = { ...job, waitMs };
    }
    return longest;
}
