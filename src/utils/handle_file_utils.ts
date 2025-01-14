import * as fs from 'fs-extra';
import * as path from 'path';
import { visit } from 'recast';
import { parse } from '@babel/parser';
import { parseComponent, compile } from '../coderfly_vue_compiler/index.js';
import lineByLine from 'n-readlines';
import { ALLOW_EXT, CODERFLY_FOLDER, IGNORE_DIRS, IS_TOP_SCOPE, TREE_FILE, TS_DECLARATION_EXT, UN_KNOWN } from '../const.js';
import { 
    AllFuncsInfo, 
    FileAstInfo, 
    FileInfo, 
    FileInfoTree, 
    FuncTreeParam, 
    GetTreeOptions, 
    NameAndPath, 
    TemplateKeyInfo 
} from '../type';
import { getTemplateInfo } from './parse_template_ast.js';
import { getFileInfoWorker } from '../worker/run_worker.js';
import { cloneDeep } from './help.js';

const { create } = require('enhanced-resolve');

function getAllFiles (folderPath: string): string[] {
    const fileList: string[] = [];

    if (fs.statSync(folderPath).isFile()) {
        return [folderPath];
    }

    function dfs(folderPath: string) {
        const files = fs.readdirSync(folderPath);

        for (let i = 0; i < files.length; i++) {

            const absolutePath = path.resolve(folderPath, files[i]);

            if (fs.statSync(absolutePath).isFile()) {
                isAllowExt(absolutePath) && fileList.push(absolutePath);
            } else {
                if (!IGNORE_DIRS.includes(absolutePath)) {
                    dfs(absolutePath);
                }
            }
        }
    }

    dfs(folderPath);

    return fileList;
}

async function getFuncTree (params: FuncTreeParam[]): Promise<FileInfoTree> {
    const tree: FileInfoTree = {};
    for (const item of params) {
        const curTree = await getFileInfoWorker(item.files, item.options);
        Object.assign(tree, curTree);
    }

    for (const file in tree) {
        const fileInfo = tree[file];
        const allFuncsInfo = fileInfo.allFuncsInfo;
        const importPkgs = fileInfo.importPkgs;

        // mix the mixin into this file
        if (fileInfo.mixin && fileInfo.mixin.length) {

            // handle writing exceptions
            // maybe some projects import mixin repeatedly if both methods come from mixin
            const handledMixinPath: string[] = [];

            for (const item of fileInfo.mixin) {
                const mixinPath = fileInfo.importPkgs[item];

                if (
                    !item || 
                    !mixinPath || 
                    mixinPath === UN_KNOWN ||
                    handledMixinPath.includes(mixinPath)
                ) continue;

                handledMixinPath.push(mixinPath);

                const mixinInfo = tree[mixinPath];
                // if meet a same function name: component first
                for (const functionName in mixinInfo['allFuncsInfo']) {
                    if (!tree[file]['allFuncsInfo'][functionName]) {
                        tree[file]['allFuncsInfo'][functionName] = mixinInfo['allFuncsInfo'][functionName];
                    }
                }
            }
        }

        // at this point, all function and it's path can be determined
        const allFunctionBelongToCurrentFile = Object.keys(allFuncsInfo);

        Object.values(allFuncsInfo).forEach(item => {
            const currentFnName = item.name;

            for (const fn of item.calledFnList) {

                // maybe fn is 'hasOwnProperty', the result of importPkgs[fn] is '[Function: hasOwnProperty]' and cause exception
                // so needs a typeof here
                if (importPkgs[fn] && typeof importPkgs[fn] === 'string') {  // the called function is imported function
                    let position;
                    try {
                        position = tree[importPkgs[fn]]['allFuncsInfo'][fn].position;
                    } catch {
                        position = UN_KNOWN;
                    }
                    allFuncsInfo[currentFnName]['calledFnFrom'][fn] = {
                        filePath: importPkgs[fn],
                        position,
                    }
                } else if (allFunctionBelongToCurrentFile.includes(fn)) {  // the called function is defined in this file
                    allFuncsInfo[currentFnName]['calledFnFrom'][fn] = {
                        filePath: allFuncsInfo[fn].filePath,
                        position: allFuncsInfo[fn].position
                    };
                } else {
                    allFuncsInfo[currentFnName]['calledFnFrom'][fn] = {
                        filePath: UN_KNOWN,
                        position: UN_KNOWN
                    }; // maybe a global function or js api, etc
                }
            }
        });
    }
    // 修改output tree中的filepath加上行号,方便再文件中直接跳转
    const _tree = cloneDeep(tree)
    Object.keys(_tree).forEach(k => {
      const fileInfo = tree[k]
      Object.keys(fileInfo.allFuncsInfo).forEach(fk => {
        const fnInfo = fileInfo.allFuncsInfo[fk]
        fnInfo.filePath = fnInfo.filePath + ':' +  fnInfo.position?.replace('L', '')
      })
    })
    fs.outputJSON(TREE_FILE, tree, {spaces: '\t'});

    return tree;
}

function getFileInfo (filePath: string, options?: GetTreeOptions): FileInfo {
    const { jsAst, templateAst, vueScriptStartLine } = getFileAst(filePath);

    if (!jsAst) {
        return {
            file: filePath,
            allFuncsInfo: {},
            importPkgs: {},
            mixin: [],
            templateKeyInfo: []
        };
    }

    const { allFuncsInfo, importPkgs } = getAllFunctions(jsAst, filePath, vueScriptStartLine ,options);

    let templateKeyInfo: TemplateKeyInfo[] = [];
    if (templateAst && templateAst.ast) {
        templateKeyInfo = getTemplateInfo(templateAst.ast);
    }

    return {
        file: filePath,
        allFuncsInfo,
        importPkgs,
        mixin: getMixin(jsAst),
        templateKeyInfo
    };
}

function getFileAst (filePath: string): FileAstInfo {
    let fileCtx = fs.readFileSync(filePath, 'utf-8');
    const extName = path.extname(filePath);

    let jsAst;
    let templateCtx = '';
    let templateAst;
    let vueScriptStartLine = 0;

    if (!ALLOW_EXT.includes(extName)) {
        return {
            file: filePath,
            jsAst,
            templateAst,
            extName,
            vueScriptStartLine
        };
    }

    if (extName === '.vue') {
        const compilerResult = parseComponent(fileCtx);
        if (compilerResult.script) {
            fileCtx = compilerResult.script.content;
            vueScriptStartLine = getVueScriptRealStartLine(filePath);
        } else {
            fileCtx = '';
        }
        templateCtx = compilerResult.template ? compilerResult.template.content : '';
    }

    try {
        jsAst = parse(fileCtx, {
            plugins: [
                'decorators-legacy',
                'typescript',
                'classProperties',
                'objectRestSpread',
                'jsx',
            ],
            sourceType: 'unambiguous'
        });

        templateAst = compile(templateCtx);
    } catch (error) {
        console.log(`ast解析错误：${filePath}`);
    }

    return {
        file: filePath,
        jsAst,
        templateAst,
        extName,
        vueScriptStartLine
    };
}

// get all functions and the functions they calls of a file
function getAllFunctions (jsAst: any, filePath: string, vueScriptStartLine: number, options?: GetTreeOptions) {
    const allFuncsInfo: AllFuncsInfo = {};
    const importPkgs: NameAndPath = {};

    const myResolve = create.sync({
        extensions: ALLOW_EXT,
        alias: options?.alias,
    });

    visit(jsAst, {
        
        // collect all imports
        visitImportDeclaration(node) {
            const specifiers = node.value.specifiers;
            const importPath = node.value.source.value;

            specifiers.forEach((item: { local: { name: string }; }) => {
                try {
                    const resolvedImportPath = myResolve(path.dirname(filePath), importPath);

                    if (resolvedImportPath) {
                        importPkgs[item.local.name] = resolvedImportPath;
                    } else {
                        importPkgs[item.local.name] = UN_KNOWN;
                    }
                } catch (error) {
                    importPkgs[item.local.name] = UN_KNOWN;
                }
            });

            return false;
        },

        // handle: function test () {}
        visitFunctionDeclaration(node) {
            let name = '';
            let position!: string;

            if (!node.value.id) {
                name = '[Anonymous]'
            } else {
                name = node.value.id.name;
            }
            
            // this means this function is called directly in the js file,not in a function block
            if (name === '') {
                name = IS_TOP_SCOPE;
            }

            if (node.value.loc) {
                position = `L${node.value.loc.start.line + vueScriptStartLine}`;
            } else if (node.parentPath && node.parentPath.value.loc) {
                position = `L${node.parentPath.value.loc.start.line + vueScriptStartLine}`;
            }

            const calledFnList = visitFunctionBlock(node, []);

            allFuncsInfo[name] = {
                name: name,
                filePath: filePath,
                position,
                calledFnList,
                calledFnFrom: {}
            };

            return false;
        },

        // handle: const test = () => {}
        visitArrowFunctionExpression(node) {
            let name = '';

            if (node.parentPath.value.type === 'VariableDeclarator') {  // eg: const test = () =>
                name = node.parentPath.value.id.name;
            } else if (node.parentPath.value.type === 'ObjectProperty') { // eg: computed: { ROLE: () => {} }
                name = node.parentPath.value.key.name;
            }

            if (name === '') {
                name = IS_TOP_SCOPE;
            }

            const calledFnList = visitFunctionBlock(node, []);

            allFuncsInfo[name] =  {
                name: name,
                filePath: filePath,
                position: `L${node.value.loc.start.line + vueScriptStartLine}`,
                calledFnList,
                calledFnFrom: {}
            };

            return false;
        },

        // handle: let test = function () {}
        visitFunctionExpression(node) {
            let name;
            if (node.parentPath.value.type === 'VariableDeclarator') {
                name = node.parentPath.value.id.name;
            } else if (node.parentPath.value.type === 'ObjectProperty') {
                name = node.parentPath.value.key.name;
            }

            if (name === '') {
                name = IS_TOP_SCOPE;
            }

            const calledFnList = visitFunctionBlock(node, []);

            allFuncsInfo[name] =  {
                name: name,
                filePath: filePath,
                position: `L${node.value.loc.start.line + vueScriptStartLine}`,
                calledFnList,
                calledFnFrom: {}
            };

            return false;
        },

        /**
         * handle:
         * class Apple {
                color () {
                    return 'red';
                }
            }
         */
        visitMethodDefinition(node) {
            let name = node.value.key.name;

            if (name === '') {
                name = IS_TOP_SCOPE;
            }

            const calledFnList = visitFunctionBlock(node, []);

            allFuncsInfo[name] = {
                name: name,
                filePath: filePath,
                position: `L${node.value.loc.start.line + vueScriptStartLine}`,
                calledFnList,
                calledFnFrom: {}
            };
            
            return false;
        },

        visitObjectMethod(node) {
            let name = node.value.key.name;

            if (name === '') {
                name = IS_TOP_SCOPE;
            }

            const calledFnList = visitFunctionBlock(node, []);

            allFuncsInfo[name] = {
                name: name,
                filePath: filePath,
                position: `L${node.value.loc.start.line + vueScriptStartLine}`,
                calledFnList,
                calledFnFrom: {}
            };

            return false;
        }
    });

    return {
        allFuncsInfo,
        importPkgs,
    };
}

// helper: visit the function block and find all functions call inside
function visitFunctionBlock(astNode: any, calledFnList: string[]): string[] {
    visit(astNode, {
        visitCallExpression(innerNode) {

            let calledFuncName = '';  // name of called function

            if (innerNode.value.callee.type === 'Identifier') {  // directly call, eg: a()
                calledFuncName = innerNode.value.callee.name;
            } else if (innerNode.value.callee.type === 'MemberExpression') {  // reference Call, eg: this.a()
                calledFuncName = innerNode.value.callee.property.name;
            }

            // TODO: filter some unnecessary functions,such as JavaScript API

            if (!calledFnList.includes(calledFuncName)) {
                calledFnList.push(calledFuncName);
            }
            
            // if there is a callback function in the called function,it needs to be searched recursively
            if (innerNode.value.arguments.length) {
                innerNode.value.arguments.forEach((argNode: any) => {
                    visitFunctionBlock(argNode, calledFnList);
                });
            }

            return false;
        }
    });

    return calledFnList;
}

function getMixin (jsAst: any) {
    let list: string[] = [];

    visit(jsAst, {
        visitObjectProperty (node) {
            if (node.value.key.type === 'Identifier' && node.value.key.name === 'mixins') {
                list = (node.value.value.elements || []).map((ele: { name: string; }) => {
                    return ele.name;
                });
            }
            return false;
        },

        // for vue-property-decorator
        visitExportDefaultDeclaration (node) {
            const decorators = node.value.declaration?.decorators || [];
            for (const decorator of decorators) {
                if (!decorator.expression || !decorator.expression.callee || decorator.expression.callee.name !== 'Component') continue;

                const decoratorArguments = decorator.expression?.arguments || [];
                for (const argumentItem of decoratorArguments) {
                    for (const propertyItem of argumentItem.properties) {
                        if (propertyItem.key.name !== 'mixins') continue;

                        const elements = propertyItem.value?.elements || [];
                        elements.forEach((ele: any) => {
                            ele.name && list.push(ele.name);
                        });
                    }
                }
            }

            return false;
        }
    });

    return list;
}

// get real line of vue script tag of a file
// because vue-template-compiler separate script and template
function getVueScriptRealStartLine (filePath: string) {
    let lineNumber = 0;
    const liner = new lineByLine(filePath);
    let line = liner.next();

    while (line) {
        if (line.toString().trim() === '<script>') {
            return lineNumber;
        }

        lineNumber++;
        line = liner.next();
    }

    return 0;
}

function isAllowExt (filePath: string) {
    return ALLOW_EXT.includes(path.extname(filePath)) && filePath.indexOf(TS_DECLARATION_EXT) === -1;
}

function confirmFolderExist () {
    if (!fs.existsSync(CODERFLY_FOLDER)) {
        fs.mkdirSync(CODERFLY_FOLDER);
    }
}

export {
    getFileInfo,
    getVueScriptRealStartLine,
    getFuncTree,
    getAllFiles,
    isAllowExt,
    confirmFolderExist,
};