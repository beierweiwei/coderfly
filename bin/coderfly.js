#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { program } from 'commander';
import { createRequire } from "module";
import ora from 'ora';
import { diff, getAllFiles, getFuncTree, getImpacts } from '../dist/index.js';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const TREE_FILE = path.resolve(process.cwd(), './file_tree.json');
const REPORT_FILE = path.resolve(process.cwd(), './impact_report.json');
const newsBoy = ora();

program
    .version(pkg.version)
    .usage('<command>')
    .description('Find function-level association impacts of code changes');

program
    .command('check <srcPath>')
    .option('-alias, --alias <alias:path...>', 'set path alias')
    .option('-t, --tree', 'export the file tree to a file')
    .description('check association impacts of code changes')
    .action((srcPath, options) => {
        let alias = {};

        if (options.alias) {
            alias = parseAlias(options.alias);
        }

        const functionDiffInfo = diff();
        newsBoy.succeed(' Function diff completed ');

        const files = getAllFiles(path.resolve(process.cwd(), srcPath));

        const tree = getFuncTree(files, {
            alias
        });
        newsBoy.succeed(' File tree build completed ');
        if (options.tree) {
            fs.writeFileSync(TREE_FILE, JSON.stringify(tree, null, 4));
            newsBoy.info(`You can check file tree from ${TREE_FILE}`);
        }

        let allFunctions = [];
        functionDiffInfo.forEach(item => {
            const file = path.resolve(process.cwd(), item.file);

            item.total.forEach(fn => {
                allFunctions.push({
                    filePath: file,
                    name: fn,
                    paths: [[fn, file]]
                });
            });
        });

        let impactReport = [];

        allFunctions.forEach(item => {
            let impact = getImpacts(tree, item);
            impactReport.push(impact);
        });
        newsBoy.succeed(' Association analysis completed ');
        
        fs.writeFileSync(REPORT_FILE, JSON.stringify(impactReport, null, 4));

        newsBoy.info(`Job done! You can check the result from ${REPORT_FILE}`);
    });

program.parse(process.argv);

function parseAlias (alias) {
    let result = {};
    if (typeof alias === 'string') {
        alias = [alias];
    }

    for (let item of alias) {
        if (!/\S+:\S+/g.test(item)) {
            continue;
        }

        const splitRes = item.split(':');

        // because it's key:value, so compare with 2
        if (splitRes.length !== 2) {
            continue;
        }

        result[splitRes[0]] = path.resolve(process.cwd(), splitRes[1]);
    }

    return result;
}
