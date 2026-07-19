const express = require('express');
const {
  getUserValidator,
  createUserValidator,
  updateUserValidator,
  deleteUserValidator,
  changeUserPasswordValidator,
  updateLoggedUserValidator,
} = require('../utils/validators/userValidator');

const {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  uploadUserImage,
  resizeImage,
  changeUserPassword,
  getLoggedUserData,
  updateLoggedUserData,
  deleteLoggedUserData,
} = require('../services/userService');
const { getProfileSummary } = require('../services/profileService');
const {
  getUserSettings,
  updateUserSettings,
  logoutAllDevices,
  changeMyPassword,
} = require('../services/settingsService');

const authService = require('../services/authService');
const {
  registerMyDeviceToken,
  unregisterMyDeviceToken,
} = require('../services/pushService');
const asyncHandler = require('express-async-handler');
const playerProfileService = require('../services/playerProfileService');

const router = express.Router();

router.use(authService.protect);

router.get('/getMe', getLoggedUserData, getUser);
router.post('/device-token', registerMyDeviceToken);
router.delete('/device-token', unregisterMyDeviceToken);
router.get('/profile', authService.allowedTo('user'), getProfileSummary);

// Public player profile for the in-app profile popup (viewable by any role,
// incl. admins who additionally get moderation actions client-side).
router.get(
  '/:id/profile',
  authService.allowedTo('user', 'admin', 'manager'),
  asyncHandler(async (req, res) => {
    const data = await playerProfileService.getPublicProfile(req.user._id, req.params.id);
    res.status(200).json({ status: 'success', data });
  })
);
router.get('/settings', authService.allowedTo('user'), getUserSettings);
router.patch('/settings', authService.allowedTo('user'), updateUserSettings);
router.post('/logout-all', authService.allowedTo('user'), logoutAllDevices);
router.put('/changeMyPassword', authService.allowedTo('user'), changeMyPassword);
router.put(
  '/updateMe',
  uploadUserImage,
  resizeImage,
  updateLoggedUserValidator,
  updateLoggedUserData
);
router.delete('/deleteMe', deleteLoggedUserData);

// Admin
router.use(authService.allowedTo('admin', 'manager'));
router.put(
  '/changePassword/:id',
  changeUserPasswordValidator,
  changeUserPassword
);
router
  .route('/')
  .get(getUsers)
  .post(uploadUserImage, resizeImage, createUserValidator, createUser);
router
  .route('/:id')
  .get(getUserValidator, getUser)
  .put(uploadUserImage, resizeImage, updateUserValidator, updateUser)
  .delete(deleteUserValidator, deleteUser);

module.exports = router;
