---
mode: 'agent'
tools: ['codebase']
description: 'Generate comprehensive tests for Python (pytest), JavaScript (Jest), and Java (JUnit) with full coverage'
---

# Test Generation — Full Coverage Guide

## Step 0 — Read Before Writing Tests
- Read the function/class/route you're testing completely
- Identify all possible code paths (if/else branches, try/catch blocks)
- Check what external services are called (DB, APIs, queues) — these need mocking
- Look at existing test files for patterns already used in the project
- Check `conftest.py` / `jest.setup.js` / `@TestConfiguration` for existing fixtures
- Never test implementation details — test behavior and outcomes

---

## What to Always Cover

For every function/endpoint, generate tests for:

| Case | HTTP Code | Description |
|---|---|---|
| Happy path | 200/201 | Valid input, expected output |
| Unauthorized | 401 | No token or expired token |
| Forbidden | 403 | Valid token, wrong role |
| Wrong org | 404 | Valid token, another org's resource |
| Not found | 404 | Resource doesn't exist |
| Validation error | 422 | Missing/wrong field types |
| Conflict | 409 | Duplicate unique field |
| Edge cases | varies | Empty string, max length, null, 0, negative numbers |
| Rate limit | 429 | If endpoint has rate limiting |

---

## Python — pytest + pytest-asyncio

### conftest.py (fixtures — read existing one first)
```python
# tests/conftest.py
import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker
from app.main import app
from app.db import get_db
from app.models import Base

# Use in-memory SQLite for tests — never real DB
TEST_DB_URL = "sqlite+aiosqlite:///:memory:"

@pytest_asyncio.fixture
async def db():
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    
    AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with AsyncSessionLocal() as session:
        yield session
    
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

@pytest_asyncio.fixture
async def client(db: AsyncSession):
    app.dependency_overrides[get_db] = lambda: db
    async with AsyncClient(app=app, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()

@pytest.fixture
def auth_headers():
    # Generate a real test JWT or use a fixed test token
    token = create_test_jwt(user_id="test-user-id", org_id="test-org-id")
    return {"Authorization": f"Bearer {token}"}

@pytest.fixture
def other_org_headers():
    token = create_test_jwt(user_id="other-user-id", org_id="other-org-id")
    return {"Authorization": f"Bearer {token}"}
```

### Route Tests — Full Coverage
```python
# tests/test_items.py
import pytest
from httpx import AsyncClient
from unittest.mock import AsyncMock, patch

class TestCreateItem:
    
    @pytest.mark.asyncio
    async def test_create_success(self, client: AsyncClient, auth_headers: dict):
        """Happy path — valid input returns 201 with created resource."""
        response = await client.post(
            "/api/v1/items",
            json={"name": "Test Item", "description": "A test"},
            headers=auth_headers
        )
        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "Test Item"
        assert "id" in data
        assert "org_id" in data
        assert "password" not in data            # never expose sensitive fields

    @pytest.mark.asyncio
    async def test_create_unauthorized_no_token(self, client: AsyncClient):
        """No auth token → 401."""
        response = await client.post("/api/v1/items", json={"name": "Test"})
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_create_unauthorized_expired_token(self, client: AsyncClient):
        """Expired token → 401."""
        response = await client.post(
            "/api/v1/items",
            json={"name": "Test"},
            headers={"Authorization": "Bearer expired.token.here"}
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_create_validation_empty_name(self, client: AsyncClient, auth_headers: dict):
        """Empty name → 422 validation error."""
        response = await client.post(
            "/api/v1/items",
            json={"name": ""},
            headers=auth_headers
        )
        assert response.status_code == 422
        assert "name" in response.json()["detail"][0]["loc"]

    @pytest.mark.asyncio
    async def test_create_validation_missing_name(self, client: AsyncClient, auth_headers: dict):
        """Missing required field → 422."""
        response = await client.post("/api/v1/items", json={}, headers=auth_headers)
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_create_validation_name_too_long(self, client: AsyncClient, auth_headers: dict):
        """Name exceeds max length → 422."""
        response = await client.post(
            "/api/v1/items",
            json={"name": "a" * 256},            # one over limit
            headers=auth_headers
        )
        assert response.status_code == 422


class TestGetItem:

    @pytest.mark.asyncio
    async def test_get_success(self, client: AsyncClient, auth_headers: dict, created_item):
        """Get own org's item → 200."""
        response = await client.get(f"/api/v1/items/{created_item.id}", headers=auth_headers)
        assert response.status_code == 200
        assert response.json()["id"] == str(created_item.id)

    @pytest.mark.asyncio
    async def test_get_wrong_org_returns_404(
        self, client: AsyncClient, other_org_headers: dict, created_item
    ):
        """Accessing another org's item → 404 (not 403 — don't reveal existence)."""
        response = await client.get(
            f"/api/v1/items/{created_item.id}",
            headers=other_org_headers
        )
        assert response.status_code == 404         # not 403! don't confirm existence

    @pytest.mark.asyncio
    async def test_get_not_found(self, client: AsyncClient, auth_headers: dict):
        """Non-existent ID → 404."""
        response = await client.get(
            "/api/v1/items/00000000-0000-0000-0000-000000000000",
            headers=auth_headers
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_get_invalid_uuid(self, client: AsyncClient, auth_headers: dict):
        """Invalid UUID format → 422."""
        response = await client.get("/api/v1/items/not-a-uuid", headers=auth_headers)
        assert response.status_code == 422


class TestListItems:
    
    @pytest.mark.asyncio
    async def test_list_empty(self, client: AsyncClient, auth_headers: dict):
        """No items → returns empty list, not 404."""
        response = await client.get("/api/v1/items", headers=auth_headers)
        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.asyncio
    async def test_list_only_own_org(
        self, client: AsyncClient, auth_headers: dict, other_org_headers: dict, db
    ):
        """Items from other orgs must not appear in results."""
        # Create item for other org
        await client.post("/api/v1/items", json={"name": "Other Org Item"}, headers=other_org_headers)
        
        response = await client.get("/api/v1/items", headers=auth_headers)
        assert response.status_code == 200
        ids = [i["id"] for i in response.json()]
        # Verify none of the other org's items appear
        assert not any(i for i in ids)  # own org has no items


class TestServiceUnit:
    """Unit tests for service layer — mock DB."""
    
    @pytest.mark.asyncio
    async def test_create_checks_org_limit(self):
        """Service should raise 429 when org hits limit."""
        with patch('crud.count_by_org', return_value=100):
            from services.item_service import ItemService
            service = ItemService(db=AsyncMock())
            with pytest.raises(Exception) as exc_info:
                await service.create({"name": "Test"}, org_id="org-123")
            assert "limit" in str(exc_info.value).lower()
```

---

## JavaScript — Jest + Supertest

### Setup (`jest.setup.js` / `tests/helpers/`)
```javascript
// tests/helpers/setup.js
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });

async function createAuthToken(orgId = 'test-org-id', userId = 'test-user-id') {
  return jwt.sign({ orgId, userId, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function cleanDatabase() {
  // Delete in dependency order
  await prisma.item.deleteMany();
  await prisma.user.deleteMany();
}

module.exports = { prisma, createAuthToken, cleanDatabase };
```

### Route Tests
```javascript
// tests/items.test.js
const request = require('supertest');
const app = require('../src/app');
const { prisma, createAuthToken, cleanDatabase } = require('./helpers/setup');

describe('Items API', () => {
  let authToken, otherOrgToken;

  beforeAll(async () => {
    authToken = await createAuthToken('org-1');
    otherOrgToken = await createAuthToken('org-2');
  });

  beforeEach(async () => await cleanDatabase());
  afterAll(async () => { await cleanDatabase(); await prisma.$disconnect(); });

  describe('POST /api/v1/items', () => {
    test('201 — creates item with valid input', async () => {
      const res = await request(app)
        .post('/api/v1/items')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Test Item' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Test Item');
      expect(res.body.orgId).toBe('org-1');
      expect(res.body).not.toHaveProperty('password');  // never expose
    });

    test('401 — no token', async () => {
      const res = await request(app).post('/api/v1/items').send({ name: 'Test' });
      expect(res.status).toBe(401);
    });

    test('422 — empty name', async () => {
      const res = await request(app)
        .post('/api/v1/items')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: '' });
      expect(res.status).toBe(422);
      expect(res.body.detail).toBeDefined();
    });

    test('422 — missing required field', async () => {
      const res = await request(app)
        .post('/api/v1/items')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});
      expect(res.status).toBe(422);
    });
  });

  describe('GET /api/v1/items/:id', () => {
    test('200 — returns own org item', async () => {
      const created = await prisma.item.create({ data: { name: 'Mine', orgId: 'org-1' } });
      const res = await request(app)
        .get(`/api/v1/items/${created.id}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(created.id);
    });

    test('404 — cannot access other org item', async () => {
      const otherItem = await prisma.item.create({ data: { name: 'NotMine', orgId: 'org-2' } });
      const res = await request(app)
        .get(`/api/v1/items/${otherItem.id}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(404);              // not 403 — don't confirm existence
    });

    test('404 — item does not exist', async () => {
      const res = await request(app)
        .get('/api/v1/items/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('Service unit tests', () => {
    test('throws 429 when org exceeds item limit', async () => {
      const itemService = require('../src/services/item.service');
      jest.spyOn(itemService, '_countByOrg').mockResolvedValue(100);
      await expect(itemService.create({ name: 'Test' }, 'org-1'))
        .rejects.toMatchObject({ status: 429 });
    });
  });
});
```

---

## Java — JUnit 5 + MockMvc + Mockito

```java
@SpringBootTest
@AutoConfigureMockMvc
@Transactional                                 // rolls back after each test
class ItemControllerTest {

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired ItemRepository repo;
    @MockBean ExternalService externalService; // mock external calls

    private String validToken;
    private String otherOrgToken;

    @BeforeEach
    void setup() {
        validToken = generateTestJwt("org-1", "user-1");
        otherOrgToken = generateTestJwt("org-2", "user-2");
    }

    @Test
    @DisplayName("POST /items — 201 with valid input")
    void createItem_success() throws Exception {
        ItemCreateRequest req = new ItemCreateRequest("Test Item", null);
        mvc.perform(post("/api/v1/items")
                .header("Authorization", "Bearer " + validToken)
                .contentType(APPLICATION_JSON)
                .content(mapper.writeValueAsString(req)))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.name").value("Test Item"))
            .andExpect(jsonPath("$.orgId").value("org-1"))
            .andExpect(jsonPath("$.password").doesNotExist());
    }

    @Test
    @DisplayName("POST /items — 401 without token")
    void createItem_noAuth() throws Exception {
        mvc.perform(post("/api/v1/items")
                .contentType(APPLICATION_JSON)
                .content(mapper.writeValueAsString(new ItemCreateRequest("Test", null))))
            .andExpect(status().isUnauthorized());
    }

    @Test
    @DisplayName("POST /items — 422 with blank name")
    void createItem_blankName() throws Exception {
        mvc.perform(post("/api/v1/items")
                .header("Authorization", "Bearer " + validToken)
                .contentType(APPLICATION_JSON)
                .content("{\"name\": \"\"}"))
            .andExpect(status().isUnprocessableEntity());
    }

    @Test
    @DisplayName("GET /items/:id — 404 for other org's item")
    void getItem_wrongOrg_returns404() throws Exception {
        Item otherOrgItem = repo.save(new Item("Other Org Item", UUID.fromString("org-2")));
        
        mvc.perform(get("/api/v1/items/" + otherOrgItem.getId())
                .header("Authorization", "Bearer " + validToken))
            .andExpect(status().isNotFound());    // not 403 — don't confirm existence
    }

    @Test
    @DisplayName("Service — throws TooManyRequests when org hits limit")
    void service_orgLimit() {
        when(repo.countByOrgId(any())).thenReturn(100L);
        assertThrows(ResponseStatusException.class, () ->
            itemService.create(new ItemCreateRequest("Test", null), UUID.randomUUID())
        );
    }
}
```

---

## Error Correction Checklist
- [ ] Cross-org isolation tested (other org's resource → 404 not 403)
- [ ] All external calls mocked — tests never hit real DB/APIs/queues
- [ ] `beforeEach` cleans state — tests are independent and order-agnostic
- [ ] Response body checked for absence of sensitive fields (password, tokens)
- [ ] Empty list tested separately from not-found (list returns `[]` not `404`)
- [ ] Both happy path AND at least 3 error cases per endpoint
- [ ] Unit tests for service/business logic separate from integration tests

Execute for: {{USER_REQUEST}}
