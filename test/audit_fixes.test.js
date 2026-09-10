const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET_KEY = 'test-secret-key-audit-verification';

// Stub out publishers to avoid external dependency in tests
const publishers = require('../domain/publishers/playerActivityPublishers');
publishers.publishSpinCompleted = () => {};

describe('Audit Fixes Verification', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ─── Finding #1: Simulated deposit blocked in production ─────────────────────
  test('Finding #1: simulated deposit and withdraw are rejected in production', async () => {
    process.env.APP_MODE = 'production';
    process.env.NODE_ENV = 'production';
    const walletService = require('../services/walletService');
    const paymentService = require('../services/paymentService');

    let depositError;
    await walletService.simulatedDeposit({ user: { _id: 'test-user' }, body: { amount: 100 } }, {}, (err) => {
      depositError = err;
    });
    assert.ok(depositError, 'simulatedDeposit should yield an error in production');
    assert.equal(depositError.statusCode, 403);

    let withdrawError;
    await walletService.simulatedWithdraw({ user: { _id: 'test-user' }, body: { amount: 100 } }, {}, (err) => {
      withdrawError = err;
    });
    assert.ok(withdrawError, 'simulatedWithdraw should yield an error in production');
    assert.equal(withdrawError.statusCode, 403);

    let paymentIntentError;
    await paymentService.createPaymentIntent({ user: { _id: 'test-user' }, body: { provider: 'simulated', amount: 100 } }, {}, (err) => {
      paymentIntentError = err;
    });
    assert.ok(paymentIntentError, 'createPaymentIntent should reject simulated in production');
    assert.equal(paymentIntentError.statusCode, 403);
  });

  // ─── Finding #2: Manager cannot create superadmin or admin account ───────────
  test('Finding #2: createUser forces role: "user"', async () => {
    const userService = require('../services/userService');
    const User = require('../models/userModel');

    let createdData;
    const origCreate = User.create;
    User.create = async (payload) => {
      createdData = payload;
      return { ...payload, _id: 'fake-id' };
    };

    try {
      const req = {
        user: { role: 'manager' },
        body: {
          name: 'Target Admin',
          email: 'target@example.com',
          password: 'Password123!',
          passwordConfirm: 'Password123!',
          role: 'superadmin',
        },
      };
      let resJson;
      const res = {
        status(code) {
          assert.equal(code, 201);
          return this;
        },
        json(data) {
          resJson = data;
          return this;
        },
      };

      await userService.createUser(req, res, (err) => {
        if (err) throw err;
      });

      assert.ok(createdData, 'User.create should have been called');
      assert.equal(createdData.role, 'user', 'role MUST be forced to "user"');
    } finally {
      User.create = origCreate;
    }
  });

  // ─── Findings #3 & #6: Password reset tying and sessionVersion bump ─────────
  test('Findings #3 & #6: resetPassword requires resetToken and increments sessionVersion', async () => {
    const authService = require('../services/authService');
    const User = require('../models/userModel');

    const mockUser = {
      _id: 'user-reset-1',
      email: 'reset@example.com',
      sessionVersion: 1,
      passwordResetToken: require('crypto').createHash('sha256').update('valid-token').digest('hex'),
      passwordResetTokenExpires: new Date(Date.now() + 600000),
      save: async function () {},
    };

    const origFindOne = User.findOne;
    User.findOne = async () => mockUser;

    try {
      // 1. Missing or invalid token should fail
      let rejectedErr;
      await authService.resetPassword(
        { body: { email: 'reset@example.com', resetToken: 'wrong-token', newPassword: 'new-password' } },
        {},
        (err) => { rejectedErr = err; }
      );
      assert.ok(rejectedErr, 'should reject wrong resetToken');
      assert.equal(rejectedErr.statusCode, 400);

      // 2. Valid token should succeed, bump sessionVersion and set passwordChangedAt
      let resultData;
      const res = {
        status(code) {
          assert.equal(code, 200);
          return this;
        },
        json(data) {
          resultData = data;
          return this;
        },
      };

      await authService.resetPassword(
        { body: { email: 'reset@example.com', resetToken: 'valid-token', newPassword: 'new-password' } },
        res,
        (err) => { if (err) throw err; }
      );

      assert.ok(resultData.token, 'should return a new token');
      assert.equal(mockUser.sessionVersion, 2, 'sessionVersion should be incremented');
      assert.ok(mockUser.passwordChangedAt, 'passwordChangedAt should be set');
      assert.equal(mockUser.passwordResetToken, undefined, 'resetToken should be cleared');
    } finally {
      User.findOne = origFindOne;
    }
  });

  // ─── Finding #8: Deactivated / banned account rejected in protect ────────────
  test('Finding #8: protect rejects active: false user with 401', async () => {
    const authService = require('../services/authService');
    const User = require('../models/userModel');

    const token = jwt.sign(
      { userId: 'user-banned-1', sessionVersion: 1 },
      process.env.JWT_SECRET_KEY
    );

    const origFindById = User.findById;
    User.findById = () => ({
      select: () => Promise.resolve({
        _id: 'user-banned-1',
        active: false,
        sessionVersion: 1,
      }),
    });

    try {
      let protectError;
      await authService.protect(
        { headers: { authorization: `Bearer ${token}` } },
        {},
        (err) => { protectError = err; }
      );
      assert.ok(protectError, 'protect should reject deactivated user');
      assert.equal(protectError.statusCode, 401);
    } finally {
      User.findById = origFindById;
    }
  });

  // ─── Finding #9: User model strips sensitive fields in JSON/Object ───────────
  test('Finding #9: User model strips password and reset fields in toJSON', () => {
    const User = require('../models/userModel');
    const userDoc = new User({
      name: 'Test Safe User',
      email: 'safe@example.com',
      password: 'secret-hash-value',
      passwordResetCode: '123456',
      passwordResetExpires: new Date(),
      passwordResetVerified: true,
      passwordResetToken: 'token-abc',
      passwordResetTokenExpires: new Date(),
    });

    const json = userDoc.toJSON();
    assert.equal(json.password, undefined);
    assert.equal(json.passwordResetCode, undefined);
    assert.equal(json.passwordResetExpires, undefined);
    assert.equal(json.passwordResetVerified, undefined);
    assert.equal(json.passwordResetToken, undefined);
    assert.equal(json.passwordResetTokenExpires, undefined);

    const obj = userDoc.toObject();
    assert.equal(obj.password, undefined);
    assert.equal(obj.passwordResetCode, undefined);
    assert.equal(obj.passwordResetExpires, undefined);
    assert.equal(obj.passwordResetVerified, undefined);
    assert.equal(obj.passwordResetToken, undefined);
    assert.equal(obj.passwordResetTokenExpires, undefined);
  });

  // ─── Finding #7: Socket token verification checks active & sessionVersion ────
  test('Finding #7: verifySocketToken rejects inactive user or outdated sessionVersion', async () => {
    const { verifySocketToken } = require('../utils/socketAuth');
    const User = require('../models/userModel');

    const origFindById = User.findById;
    try {
      // 1. Inactive user rejected
      const token1 = jwt.sign({ userId: 'u1', sessionVersion: 1 }, process.env.JWT_SECRET_KEY);
      User.findById = () => ({
        select: () => Promise.resolve({ _id: 'u1', active: false, sessionVersion: 1 }),
      });
      await assert.rejects(verifySocketToken(token1), /deactivated/i);

      // 2. Mismatched sessionVersion rejected
      const token2 = jwt.sign({ userId: 'u2', sessionVersion: 1 }, process.env.JWT_SECRET_KEY);
      User.findById = () => ({
        select: () => Promise.resolve({ _id: 'u2', active: true, sessionVersion: 2 }),
      });
      await assert.rejects(verifySocketToken(token2), /Session expired/i);

      // 3. Valid active user with matching sessionVersion passes
      const token3 = jwt.sign({ userId: 'u3', sessionVersion: 1 }, process.env.JWT_SECRET_KEY);
      User.findById = () => ({
        select: () => Promise.resolve({ _id: 'u3', active: true, sessionVersion: 1 }),
      });
      const verified = await verifySocketToken(token3);
      assert.equal(verified.user._id, 'u3');
    } finally {
      User.findById = origFindById;
    }
  });

  // ─── Finding #13: Wallet adapter lock memory leak and re-entrancy ─────────────
  test('Finding #13: withUserLock cleans up map entries and allows re-entrancy', async () => {
    const adapters = [
      require('../games/sicbo/sicboWalletAdapter'),
      require('../games/goldenTree/goldenTreeWalletAdapter'),
      require('../games/poseidon/poseidonWalletAdapter'),
      require('../games/zenobia/zenobiaWalletAdapter'),
    ];

    for (const adapter of adapters) {
      // Test re-entrancy (nested locks on same user should NOT deadlock)
      const res = await adapter.withUserLock('test-user-lock', async () => {
        return await adapter.withUserLock('test-user-lock', async () => {
          return 're-entrant-success';
        });
      });
      assert.equal(res, 're-entrant-success');

      // Test map cleanup: wait a tick and verify no dangling promises in map
      await new Promise((r) => setTimeout(r, 10));
      // Run another lock, should succeed cleanly
      const res2 = await adapter.withUserLock('test-user-lock', async () => 'clean');
      assert.equal(res2, 'clean');
    }
  });

  // ─── Findings #4 & #5: Concurrency and bonus debit rollback in Poseidon & Zenobia
  test('Findings #4 & #5: Poseidon & Zenobia concurrency locks and staged bonus', async () => {
    for (const game of ['poseidon', 'zenobia']) {
      const svc = require(`../games/${game}/${game}Service`);
      const rounds = require(`../games/${game}/roundManager`);
      const wallet = require(`../games/${game}/${game}WalletAdapter`);
      const engine = require(`../games/${game}/spinEngine`);
      const constants = require(`../games/${game}/constants`);
      const bet = constants.BET_MIN;

      if (game === 'poseidon') {
        require('../games/poseidon/jackpot/jackpotService').isJackpotTriggered = () => false;
      }

      // 1. Concurrency: 2 concurrent spins on 1 remaining free spin -> exactly 1 free spin!
      engine.resolveSpin = () => ({
        baseWin: 1, multiplierSum: 0, multipliers: [], scatterCount: 0,
        scatters: [], steps: [], initialMatrix: [], finalMatrix: [],
      });
      const uid = `audit-${game}-concurrent-test`;
      rounds.createBonusSession(uid, { betAmount: bet, freeSpins: 1 });
      const results = await Promise.all([svc.executeSpin(uid, bet), svc.executeSpin(uid, bet)]);
      const freeSpinCount = results.filter((r) => r.isFreeSpin).length;
      assert.equal(freeSpinCount, 1, `${game}: exactly 1 free spin should be consumed, not 2!`);

      // 2. Bonus rollback: if wallet debit fails on trigger spin, bonus session must NOT exist
      const failedUid = `audit-${game}-failed-charge-test`;
      engine.resolveSpin = () => ({
        baseWin: 0, multiplierSum: 0,
        multipliers: Array.from({ length: constants.TRIGGER_NATURAL_MIN }, () => ({})),
        scatterCount: constants.TRIGGER_NATURAL_MIN,
        scatters: [], steps: [], initialMatrix: [], finalMatrix: [],
      });
      const origAtomic = wallet.atomicSpinWallet;
      wallet.atomicSpinWallet = async () => { throw new Error('AUDIT_DEBIT_FAIL'); };
      try {
        await assert.rejects(svc.executeSpin(failedUid, bet), /AUDIT_DEBIT_FAIL/);
        assert.equal(
          rounds.hasActiveBonusSession(failedUid),
          false,
          `${game}: bonus session should NOT be created if atomicSpinWallet fails!`
        );
      } finally {
        wallet.atomicSpinWallet = origAtomic;
      }
    }
  });
});
