#!/usr/bin/env node

const os = require('os');
const fs = require('fs');
const https = require('https');
const child_process = require('child_process');
const axios = require('axios');
const jsdom = require('jsdom').JSDOM;
const cliProgress = require('cli-progress');

const CONCURRENT_DOWNLOADS = 4;

const axiosInstance = axios.create({
    httpsAgent: new https.Agent({
        rejectUnauthorized: false
    })
});

async function main() {
    const source = process.argv[2].replace(/\/+$/, '');

    if (typeof source === 'undefined' || source === '') {
        console.error('No source give. Example: node index.js https://radicaldreamland.bandcamp.com');
        process.exit(1);
    }

    const res = await axiosInstance.get(source);
    const page = res.data;
    const dom = new jsdom(page);
    const nodeList = dom.window.document.querySelectorAll(".music-grid-item");
    const artist = dom.window.document.querySelector("#band-name-location .title").textContent;

    console.log(artist);
    console.log('-'.repeat(artist.length));

    const multiBar = new cliProgress.MultiBar({
        clearOnComplete: false,
        hideCursor: true,
        format: `[{bar}] {percentage}% | ETA: {eta}s | {value}/{total} {album} - {title} - {status}`,
    }, cliProgress.Presets.shades_grey);

    const promiseArgs = [].map.call(nodeList, node => {
        return {
            node,
            bar: multiBar.create(1, 0, { status: 'Waiting...' }),
        }
    })

    promisePool(CONCURRENT_DOWNLOADS, promiseArgs, newPromise).then(() => {
        multiBar.stop();
        console.log("done!");
    });

    function newPromise(args) {
        const { node, bar } = args;

        return new Promise((resolve, reject) => {
            const href = node.querySelector("a").href;
            const album = safeName(node.querySelector(".title").textContent.trim().replace(/[\s\r\n]+/g, ' '));
            const url = `${source}${href}`;

            fs.mkdir(album, () => {
                const proc = child_process.spawn(`youtube-dl`, [url], { cwd: album });

                proc.stdout.on('data', data => {
                    const msg = data.toString();
                    const match = /(\d+)\sof\s(\d+)/g.exec(msg);

                    if (match) {
                        const progress = parseInt(match[1]);
                        const total = parseInt(match[2]);
                        bar.setTotal(total);
                        bar.update(progress, { album, status: "Downloading..." });
                    } else {
                        const titleMatch = /\[Bandcamp.*\]\s(.*): Downloading webpage/g.exec(msg);
                        if (titleMatch) {
                            bar.update({ album, title: titleMatch[1] });
                        }
                    }
                });

                proc.stderr.on('data', err => {
                    bar.update({ status: err.toString() });
                });

                proc.on('close', (code) => {
                    if (code === 0) {
                        bar.update(bar.total, { status: `Done!` });
                    }

                    bar.stop();
                    resolve();
                });
            });
        });
    }
}

main();

function promisePool(poolLimit, args, promiseConstructor) {
    return new Promise((resolve, reject) => {
        let i = 0;
        const allPromises = [];
        const racingPromises = [];

        function enqueue() {
            if (allPromises.length === args.length) {
                // Every promise has been created, one just waits for them to resolve
                Promise.all(allPromises)
                    .then(values => {
                        resolve(values);
                    })
                    .catch(e => reject(e));
            } else {
                // Create a new promise and add it to the running pool
                const arg = args[i++];
                const promise = promiseConstructor(arg);
                promise.then(() => racingPromises.splice(racingPromises.indexOf(promise), 1));
                allPromises.push(promise);
                racingPromises.push(promise);

                if (racingPromises.length < poolLimit) {
                    enqueue();
                } else {
                    Promise.race(racingPromises)
                        .then(() => {
                            enqueue();
                        })
                        .catch(e => reject(e));
                }
            }
        }

        enqueue();
    });
}

function safeName(str) {
    return str.replace(/[\<\>\:\"\/\\\|\?\*]/g, '-');
}
