// node --test scripts/lib/openapi-validator.test.js
// Parser de YAML (subconjunto), extração de endpoints/status/DTO do Java e o
// confronto contrato x Resource, com uma árvore src/main/java sintética em tmp.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Mapa sintético do próprio teste. O runner descarta OPENAPI_* do operador;
// ResponseFactory.ok/badRequest só viram status com este arquivo.
process.env.OPENAPI_RESPONSE_FACTORY_FILE = path.join(__dirname, '..', 'fixtures', 'openapi-response-factory.json');

const {
    validate, toMarkdown, parseYaml, javaEndpoints, javaStatuses, dtoFieldsFromSource, pathsMatch,
} = require('./openapi-validator');

const CLI = path.join(__dirname, 'openapi-validator.js');

const RESOURCE = `package br.com.x.pedido;

import jakarta.ws.rs.*;

@Path("/pedidos")
@Produces(MediaType.APPLICATION_JSON)
public class PedidoResource {

    @Inject
    PedidoService service;

    // @POST comentado não conta
    /* @DELETE
       public Response apagar() {} */

    @POST
    @Consumes(MediaType.APPLICATION_JSON)
    public Response criar(PedidoRequest request) {
        if (request.cliente() == null) {
            return Response.status(Response.Status.BAD_REQUEST).entity("cliente").build();
        }
        return Response.status(201).entity(service.criar(request)).build();
    }

    @PUT
    @Path("{id: [0-9]+}/itens")
    public Response itens(@PathParam("id") Long id, String json) {
        ItemPedidoDTO dto = Json.fromJson(json, ItemPedidoDTO.class);
        if (dto == null) throw new NotFoundException();
        return ResponseFactory.ok("atualizado");
    }

    @GET
    @Path("{id}")
    public Response buscar(@PathParam("id") Long id) {
        return Response.status(resposta.getStatusCode()).build();
    }

    @GET
    @Path("resumo")
    public Response resumo() {
        return montarResumo();
    }
}
`;

const PEDIDO_REQUEST = `package br.com.x.pedido.dto;

public record PedidoRequest(String cliente, @SerializedName("valor_total") BigDecimal valorTotal, List<String> itens) {
}
`;

const ITEM_DTO = `package br.com.x.pedido.dto;

public class ItemPedidoDTO extends BaseDTO {
    public static final String TIPO = "ITEM";
    private transient String cache;
    private Integer quantidade;
    @JsonProperty("sku")
    private String codigoProduto;
    private List<Map<String, Integer>> extras = new ArrayList<>();

    public ItemPedidoDTO() {
        this.quantidade = 0;
    }

    public Integer getQuantidade() { return quantidade; }
}
`;

const BASE_DTO = `package br.com.x.pedido.dto;

public abstract class BaseDTO {
    protected String oid;
    public abstract String tipo();
}
`;

function contract({ criarProps, criarResponses = ['201', '400', '422', '500'], itensProps } = {}) {
    const props = criarProps || ['cliente', 'valor_total', 'itens'];
    const types = { cliente: 'string', valor_total: 'number', itens: 'array', observacao: 'string' };
    return `openapi: 3.0.3
info:
  title: Contrato TASK-teste
  version: "1.0"
paths:
  /api/v1/pedidos:
    post:
      summary: Cria pedido
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/PedidoRequest'
            example:
              cliente: "ACME Ltda"
              valor_total: 199.9
              itens: ["SKU-1", "SKU-2"]
      responses:
${criarResponses.map(c => `        '${c}':\n          description: resposta ${c}`).join('\n')}
  /api/v1/pedidos/{id}/itens:
    put:
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: integer }
      requestBody:
        content:
          application/json:
            schema:
              type: object
              x-java-dto: ItemPedidoDTO
              properties:
${(itensProps || ['quantidade', 'sku', 'oid', 'extras']).map(p => `                ${p}:\n                  type: ${p === 'quantidade' ? 'integer' : p === 'extras' ? 'array' : 'string'}`).join('\n')}
      responses:
        "200": { description: ok }
        "404": { description: não encontrado }
components:
  schemas:
    PedidoRequest:
      type: object
      required: [cliente]
      properties:
${props.map(p => `        ${p}:\n          type: ${types[p] || 'string'}`).join('\n')}
`;
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-validator-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pkg = path.join(root, 'src', 'main', 'java', 'br', 'com', 'x', 'pedido');
    fs.mkdirSync(path.join(pkg, 'dto'), { recursive: true });
    const resource = path.join(pkg, 'PedidoResource.java');
    fs.writeFileSync(resource, RESOURCE);
    fs.writeFileSync(path.join(pkg, 'dto', 'PedidoRequest.java'), PEDIDO_REQUEST);
    fs.writeFileSync(path.join(pkg, 'dto', 'ItemPedidoDTO.java'), ITEM_DTO);
    fs.writeFileSync(path.join(pkg, 'dto', 'BaseDTO.java'), BASE_DTO);
    return { root, resource };
}

const byType = (result, type) => result.divergences.filter(d => d.type === type);

// ---------------------------------------------------------------- YAML

test('parseYaml: mapas, listas, flow, block scalar, comentários e chaves numéricas', () => {
    const doc = parseYaml(`# topo
openapi: 3.0.3
info:
  title: "Contrato # não é comentário"  # comentário
  version: '1.0'
  description: |
    Linha 1
    Linha 2
  summary: >
    dobrado
    numa linha
tags:
- a
- "b"
paths:
  /x:
    get:
      parameters:
        - name: id
          in: path
          schema: { type: integer, enum: [1, 2] }
        -
          name: q
          in: query
      responses:
        '200':
          description: ok
        404: { description: "não achou" }
empty:
list_flow: [1, "dois", true, null]
multi: [
  a,
  b
]
`);
    assert.strictEqual(doc.openapi, '3.0.3');
    assert.strictEqual(doc.info.title, 'Contrato # não é comentário');
    assert.strictEqual(doc.info.version, '1.0');
    assert.strictEqual(doc.info.description, 'Linha 1\nLinha 2\n');
    assert.strictEqual(doc.info.summary, 'dobrado numa linha\n');
    assert.deepStrictEqual(doc.tags, ['a', 'b']);
    const params = doc.paths['/x'].get.parameters;
    assert.deepStrictEqual(params[0], { name: 'id', in: 'path', schema: { type: 'integer', enum: [1, 2] } });
    assert.deepStrictEqual(params[1], { name: 'q', in: 'query' });
    assert.deepStrictEqual(Object.keys(doc.paths['/x'].get.responses), ['200', '404']);
    assert.strictEqual(doc.paths['/x'].get.responses['404'].description, 'não achou');
    assert.strictEqual(doc.empty, null);
    assert.deepStrictEqual(doc.list_flow, [1, 'dois', true, null]);
    assert.deepStrictEqual(doc.multi, ['a', 'b']);
});

test('parseYaml: aceita JSON e rejeita indentação quebrada', () => {
    assert.deepStrictEqual(parseYaml('{"paths": {}}'), { paths: {} });
    assert.throws(() => parseYaml('a:\n  b: 1\n    c: 2\n'), /indentação/);
});

// ---------------------------------------------------------------- Java

test('javaEndpoints: @Path de classe + método, regex de path param, ignora comentários', () => {
    const eps = javaEndpoints('R.java', RESOURCE);
    assert.deepStrictEqual(eps.map(e => `${e.method} ${e.path} ${e.name}`), [
        'POST /pedidos criar',
        'PUT /pedidos/{id: [0-9]+}/itens itens',
        'GET /pedidos/{id} buscar',
        'GET /pedidos/resumo resumo',
    ]);
    const itens = eps[1];
    assert.deepStrictEqual(itens.params.map(p => `${p.source}:${p.type}:${p.name}`), ['PathParam:Long:id', 'body:String:json']);
    assert.strictEqual(eps[0].line, 16);
});

test('javaStatuses: Status enum, número, ResponseFactory, exceção e status dinâmico', () => {
    const eps = javaEndpoints('R.java', RESOURCE);
    assert.deepStrictEqual([...javaStatuses(eps[0].body, eps[0].bodyLine).codes.keys()].sort(), [201, 400]);
    assert.deepStrictEqual([...javaStatuses(eps[1].body, eps[1].bodyLine).codes.keys()].sort(), [200, 404]);
    const dyn = javaStatuses(eps[2].body, eps[2].bodyLine);
    assert.strictEqual(dyn.codes.size, 0);
    assert.strictEqual(dyn.dynamic.length, 1);
});

test('dtoFieldsFromSource: record com @SerializedName e classe (sem static/transient/métodos)', () => {
    assert.deepStrictEqual(dtoFieldsFromSource(PEDIDO_REQUEST, 'PedidoRequest').fields.map(f => `${f.jsonName}:${f.type}`),
        ['cliente:String', 'valor_total:BigDecimal', 'itens:List<String>']);
    const item = dtoFieldsFromSource(ITEM_DTO, 'ItemPedidoDTO');
    assert.deepStrictEqual(item.fields.map(f => `${f.jsonName}:${f.type}`),
        ['quantidade:Integer', 'sku:String', 'extras:List<Map<String, Integer>>']);
    assert.strictEqual(item.superName, 'BaseDTO');
});

test('pathsMatch: prefixo da aplicação e nome de path param não importam', () => {
    assert.ok(pathsMatch('/api/v1/pedidos/{pedidoId}/itens', '/pedidos/{id: [0-9]+}/itens'));
    assert.ok(pathsMatch('/pedidos', '/pedidos/'));
    assert.ok(!pathsMatch('/api/v1/xpedidos', '/pedidos'));
    assert.ok(!pathsMatch('/pedidos/{id}', '/pedidos'));
});

// ---------------------------------------------------------------- validate

test('contrato que bate com o Resource: sem FAIL', t => {
    const { resource } = fixture(t);
    const r = validate({ contractText: contract(), javaFiles: [resource] });
    assert.deepStrictEqual(r.divergences.filter(d => d.severity === 'FAIL'), []);
    assert.strictEqual(r.summary.passed, true);
    const criar = r.endpoints.find(e => e.method === 'POST');
    assert.strictEqual(criar.dto.name, 'PedidoRequest');
    assert.match(criar.dto.resolvedBy, /parâmetro/);
    const itens = r.endpoints.find(e => e.method === 'PUT');
    assert.strictEqual(itens.dto.resolvedBy, 'x-java-dto');
    // oid vem da superclasse BaseDTO.
    assert.ok(itens.dto.fields.includes('oid'));
    // 422 declarado mas não produzido explicitamente: só aviso.
    assert.ok(byType(r, 'declared_status_unused').some(d => /422/.test(d.detail) && d.severity === 'WARN'));
});

test('DTO com campo faltante em relação ao contrato -> FAIL missing_field', t => {
    const { resource } = fixture(t);
    const r = validate({ contractText: contract({ criarProps: ['cliente', 'valor_total', 'itens', 'observacao'] }), javaFiles: [resource] });
    const missing = byType(r, 'missing_field');
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(missing[0].severity, 'FAIL');
    assert.strictEqual(missing[0].field, 'observacao');
    assert.match(missing[0].file, /PedidoRequest\.java$/);
    assert.strictEqual(r.summary.passed, false);
    assert.match(toMarkdown(r), /^- \[FAIL\] OpenAPI POST \/api\/v1\/pedidos — missing_field: campo "observacao"/m);
});

test('campo do DTO fora do contrato e tipo divergente -> WARN', t => {
    const { resource } = fixture(t);
    const text = contract({ criarProps: ['cliente', 'valor_total'] }).replace('valor_total:\n          type: number', 'valor_total:\n          type: boolean');
    const r = validate({ contractText: text, javaFiles: [resource] });
    assert.ok(byType(r, 'extra_field').some(d => d.field === 'itens' && d.severity === 'WARN'));
    assert.ok(byType(r, 'type_mismatch').some(d => d.field === 'valor_total' && d.severity === 'WARN'));
    assert.strictEqual(r.summary.passed, true);
});

test('status retornado fora do contrato -> FAIL; 2xx declarado e não produzido -> WARN', t => {
    const { resource } = fixture(t);
    const r = validate({ contractText: contract({ criarResponses: ['200', '422', '500'] }), javaFiles: [resource] });
    const statuses = byType(r, 'status_not_in_contract').map(d => d.status).sort();
    assert.deepStrictEqual(statuses, [201, 400]);
    assert.ok(byType(r, 'status_not_in_contract').every(d => d.severity === 'FAIL' && d.line));
    assert.ok(byType(r, 'declared_status_unused').some(d => d.method === 'POST' && /200/.test(d.detail) && d.severity === 'WARN'));
});

test('contrato declara 2xx e o método só retorna erro -> FAIL success_status_missing', t => {
    const { resource } = fixture(t);
    fs.writeFileSync(resource, RESOURCE.replace('return Response.status(201).entity(service.criar(request)).build();', 'return ResponseFactory.badRequest("sempre");'));
    const r = validate({ contractText: contract(), javaFiles: [resource] });
    const missing = byType(r, 'success_status_missing');
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(missing[0].severity, 'FAIL');
});

test('endpoint do contrato inexistente no Resource -> FAIL endpoint_not_found', t => {
    const { resource } = fixture(t);
    const text = contract().replace('  /api/v1/pedidos:\n    post:', '  /api/v1/pedidos/lote:\n    post:');
    const r = validate({ contractText: text, javaFiles: [resource] });
    const nf = byType(r, 'endpoint_not_found');
    assert.strictEqual(nf.length, 1);
    assert.strictEqual(nf[0].path, '/api/v1/pedidos/lote');
});

test('status dinâmico e método sem status explícito -> WARN, não FAIL', t => {
    const { resource } = fixture(t);
    const text = `openapi: 3.0.3
paths:
  /pedidos/{id}:
    get:
      responses:
        '200': { description: ok }
  /pedidos/resumo:
    get:
      responses:
        '200': { description: ok }
`;
    const r = validate({ contractText: text, javaFiles: [resource] });
    assert.strictEqual(byType(r, 'dynamic_status').length, 1);
    assert.strictEqual(byType(r, 'no_status_detected').length, 1);
    assert.strictEqual(r.summary.fail, 0);
});

test('DTO não localizado -> WARN dto_not_found', t => {
    const { resource } = fixture(t);
    const text = contract().replace('x-java-dto: ItemPedidoDTO', 'x-java-dto: NaoExiste').replace('ItemPedidoDTO.class', 'X');
    fs.writeFileSync(resource, RESOURCE.replace('ItemPedidoDTO dto = Json.fromJson(json, ItemPedidoDTO.class);', 'Object dto = json;'));
    const r = validate({ contractText: text, javaFiles: [resource] });
    assert.ok(byType(r, 'dto_not_found').some(d => d.method === 'PUT' && d.severity === 'WARN'));
});

// ---------------------------------------------------------------- CLI

test('CLI: exit 0 sem FAIL, 1 com FAIL, 2 com uso incorreto; --md', t => {
    const { root, resource } = fixture(t);
    const ok = path.join(root, 'ok.yaml');
    const bad = path.join(root, 'bad.yaml');
    fs.writeFileSync(ok, contract());
    fs.writeFileSync(bad, contract({ criarProps: ['cliente', 'observacao'] }));

    const out = JSON.parse(execFileSync('node', [CLI, ok, resource], { encoding: 'utf8' }));
    assert.strictEqual(out.summary.passed, true);

    let err;
    try { execFileSync('node', [CLI, bad, path.join(root, 'src'), '--md'], { encoding: 'utf8' }); } catch (e) { err = e; }
    assert.strictEqual(err.status, 1);
    assert.match(err.stdout, /\[FAIL\] OpenAPI POST \/api\/v1\/pedidos — missing_field/);

    let usage;
    try { execFileSync('node', [CLI, ok], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { usage = e; }
    assert.strictEqual(usage.status, 2);
});
