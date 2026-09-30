const express = require('express');
const {
  signupValidator,
  loginValidator,
} = require('../utils/validators/authValidator');

const {
  signup,
  login,
  forgotPassword,
  verifyPassResetCode,
  resetPassword,
  socialLogin,
} = require('../services/authService');

const router = express.Router();

router.post('/signup', signupValidator, signup);
router.post('/login', loginValidator, login);
router.post('/social-login', socialLogin);
router.post('/google', (req, res, next) => {
  req.body.provider = 'google';
  return socialLogin(req, res, next);
});
router.post('/facebook', (req, res, next) => {
  req.body.provider = 'facebook';
  return socialLogin(req, res, next);
});
router.post('/forgotPassword', forgotPassword);
router.post('/verifyResetCode', verifyPassResetCode);
router.put('/resetPassword', resetPassword);

module.exports = router;
