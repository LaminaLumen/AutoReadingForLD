import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PREVIEW_PORT || 4173);
const fixtureUrl = new URL('../tests/fixtures/topic.html', import.meta.url);
const scriptUrl = new URL('../AutoReadingForLD.user.js', import.meta.url);

const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url || '/', `http://${request.headers.host || `127.0.0.1:${port}`}`);
        const isUserscript = url.pathname === '/AutoReadingForLD.user.js';
        const body = await readFile(isUserscript ? scriptUrl : fixtureUrl);

        // 每次请求重新读取文件，编辑脚本后刷新页面即可看到最新版本。
        response.writeHead(200, {
            'Content-Type': isUserscript
                ? 'text/javascript; charset=utf-8'
                : 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        response.end(body);
    } catch (error) {
        response.writeHead(500, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        response.end(`预览文件读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`AutoReadingForLD 预览地址：http://127.0.0.1:${port}/t/topic/1001`);
    console.log(`连续阅读列表：http://127.0.0.1:${port}/new`);
});
