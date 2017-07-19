import url from "url";
import packageJson from "/package.json";
import { merge, uniqWith } from "lodash";
import _ from "lodash";
import { Meteor } from "meteor/meteor";
import { check, Match } from "meteor/check";
import { Random } from "meteor/random";
import { Accounts } from "meteor/accounts-base";
import { Roles } from "meteor/alanning:roles";
import { EJSON } from "meteor/ejson";
import { Jobs, Packages, Shops, Groups } from "/lib/collections";
import { Hooks, Logger } from "/server/api";
import ProcessJobs from "/server/jobs";
import { registerTemplate } from "./templates";
import { sendVerificationEmail } from "./accounts";
import { getMailUrl } from "./email/config";


export default {

  init() {
    // make sure the default shop has been created before going further
    while (!this.getShopId()) {
      Logger.warn("No shopId, waiting one second...");
      Meteor._sleepForMs(1000);
    }

    // run onCoreInit hooks
    Hooks.Events.run("onCoreInit");

    // start job server
    Jobs.startJobServer(() => {
      Logger.info("JobServer started");
      ProcessJobs();
      Hooks.Events.run("onJobServerStart");
    });
    if (process.env.VERBOSE_JOBS) {
      Jobs.setLogStream(process.stdout);
    }
    this.loadPackages();
    // process imports from packages and any hooked imports
    this.Import.flush();
    this.createDefaultGroups();
    // timing is important, packages are rqd for initial permissions configuration.
    if (!Meteor.isAppTest) {
      this.createDefaultAdminUser();
    }
    this.setAppVersion();
    // hook after init finished
    Hooks.Events.run("afterCoreInit");

    Logger.debug("Reaction.init() has run");

    return true;
  },

  Packages: {},

  registerPackage(packageInfo) {
    const registeredPackage = this.Packages[packageInfo.name] = packageInfo;
    return registeredPackage;
  },
  createDefaultGroups() {
    const allGroups = Groups.find({}).fetch();
    const shops = Shops.find({}).fetch();
    const roles = {
      customer: [ "guest", "account/profile", "product", "tag", "index", "cart/checkout", "cart/completed"],
      guest: ["anonymous", "guest", "product", "tag", "index", "cart/checkout", "cart/completed"],
      owner: Roles.getAllRoles().fetch().map(role => role.name)
    };

    if (shops && shops.length) {
      shops.forEach(shop => createGroupsForShop(shop));
    }
    function createGroupsForShop(shop) {
      Object.keys(roles).forEach(groupKeys => {
        const groupExists = allGroups.find(grp => grp.slug === groupKeys && grp.shopId === shop._id);
        if (!groupExists) { // create group only if it doesn't exist before
          Logger.debug(`creating group ${groupKeys} for shop ${shop.name}`);
          Groups.insert({
            name: groupKeys,
            slug: groupKeys,
            permissions: roles[groupKeys],
            shopId: shop._id
          });
        }
      });
    }
  },
  /**
   * registerTemplate
   * registers Templates into the Templates Collection
   * @return {function} Registers template
   */
  registerTemplate: registerTemplate,

  /**
   * hasPermission - server
   * server permissions checks
   * hasPermission exists on both the server and the client.
   * @param {String | Array} checkPermissions -String or Array of permissions if empty, defaults to "admin, owner"
   * @param {String} userId - userId, defaults to Meteor.userId()
   * @param {String} checkGroup group - default to shopId
   * @return {Boolean} Boolean - true if has permission
   */
  hasPermission(checkPermissions, userId = Meteor.userId(), checkGroup = this.getShopId()) {
    // check(checkPermissions, Match.OneOf(String, Array)); check(userId, String); check(checkGroup,
    // Match.Optional(String));

    let permissions;
    // default group to the shop or global if shop isn't defined for some reason.
    let group;
    if (checkGroup !== undefined && typeof checkGroup === "string") {
      group = checkGroup;
    } else {
      group = this.getShopId() || Roles.GLOBAL_GROUP;
    }

    // permissions can be either a string or an array we'll force it into an array and use that
    if (checkPermissions === undefined) {
      permissions = ["owner"];
    } else if (typeof checkPermissions === "string") {
      permissions = [checkPermissions];
    } else {
      permissions = checkPermissions;
    }

    // if the user has admin, owner permissions we'll always check if those roles are enough
    permissions.push("owner");
    permissions = _.uniq(permissions);

    // return if user has permissions in the group
    if (Roles.userIsInRole(userId, permissions, group)) {
      return true;
    }

    // global roles check
    const sellerShopPermissions = Roles.getGroupsForUser(userId, "admin");

    // we're looking for seller permissions.
    if (sellerShopPermissions) {
      // loop through shops roles and check permissions
      for (const key in sellerShopPermissions) {
        if (key) {
          const shop = sellerShopPermissions[key];
          if (Roles.userIsInRole(userId, permissions, shop)) {
            return true;
          }
        }
      }
    }
    // no specific permissions found returning false
    return false;
  },

  hasOwnerAccess() {
    return this.hasPermission(["owner"]);
  },

  hasAdminAccess() {
    return this.hasPermission(["owner", "admin"]);
  },

  hasDashboardAccess() {
    return this.hasPermission(["owner", "admin", "dashboard"]);
  },

  getSellerShopId() {
    return Roles.getGroupsForUser(this.userId, "admin");
  },

  configureMailUrl() {
    // maintained for legacy support
    Logger.warn("Reaction.configureMailUrl() is deprecated. Please use Reaction.Email.getMailUrl() instead");
    return getMailUrl();
  },

  getPrimaryShop() {
    const primaryShop = Shops.findOne({
      shopType: "primary"
    });

    return primaryShop;
  },

  // primaryShopId is the first created shop. In a marketplace setting it's
  // the shop that controls the marketplace and can see all other shops.
  getPrimaryShopId() {
    const primaryShop = this.getPrimaryShop();
    if (primaryShop) {
      return primaryShop._id;
    }
  },

  getPrimaryShopName() {
    const primaryShop = this.getPrimaryShop();
    if (primaryShop) {
      return primaryShop.name;
    }
    // If we can't find the primaryShop return an empty string
    return "";
  },

  // Primary Shop should probably not have a prefix (or should it be /shop?)
  getPrimaryShopPrefix() {
    return "/" + this.getSlug(this.getPrimaryShopName().toLowerCase());
  },

  getPrimaryShopSettings() {
    const settings = Packages.findOne({
      name: "core",
      shopId: this.getPrimaryShopId()
    }) || {};
    return settings.settings || {};
  },

  getPrimaryShopCurrency() {
    const primaryShop = this.getPrimaryShop();

    if (primaryShop && primaryShop.currency) {
      return primaryShop.currency;
    }

    return "USD";
  },

  /**
   * **DEPRECATED** This method has been deprecated in favor of using getShopId
   * and getPrimaryShopId. To be removed.
   * @deprecated
   * @method getCurrentShopCursor
   * @return {Cursor} cursor of shops that match the current domain
   */
  getCurrentShopCursor() {
    const domain = this.getDomain();
    const cursor = Shops.find({
      domains: domain
    });
    if (!cursor.count()) {
      Logger.debug(domain, "Add a domain entry to shops for ");
    }
    return cursor;
  },

  /**
   * **DEPRECATED** This method has been deprecated in favor of using getShopId
   * and getPrimaryShopId. To be removed.
   * @deprecated
   * @method getCurrentShop
   * @return {Object} returns the first shop object from the shop cursor
   */
  getCurrentShop() {
    const currentShopCursor = this.getCurrentShopCursor();
    // also, we could check in such a way: `currentShopCursor instanceof Object` but not instanceof something.Cursor
    if (typeof currentShopCursor === "object") {
      return currentShopCursor.fetch()[0];
    }
    return null;
  },

  getShopId(userId) {
    check(userId, Match.Maybe(String));
    const activeUserId = Meteor.call("reaction/getUserId");
    if (activeUserId || userId) {
      const activeShopId = this.getUserPreferences({
        userId: activeUserId || userId,
        packageName: "reaction",
        preference: "activeShopId"
      });
      if (activeShopId) {
        return activeShopId;
      }
    }

    // TODO: This should intelligently find the correct default shop
    // Probably whatever the main shop is or the marketplace
    const domain = this.getDomain();
    const shop = Shops.find({
      domains: domain
    }, {
      limit: 1,
      fields: {
        _id: 1
      }
    }).fetch()[0];
    return shop && shop._id;
  },

  getDomain() {
    return url.parse(Meteor.absoluteUrl()).hostname;
  },

  getShopName() {
    const shopId = this.getShopId();
    let shop;
    if (shopId) {
      shop = Shops.findOne({
        _id: shopId
      }, {
        fields: {
          name: 1
        }
      });
    } else {
      const domain = this.getDomain();
      shop = Shops.findOne({
        domains: domain
      }, {
        fields: {
          name: 1
        }
      });
    }
    if (shop && shop.name) {
      return shop.name;
    }
    // If we can't find the shop or shop name return an empty string
    // so that string methods that rely on getShopName don't error
    return "";
  },

  getShopPrefix() {
    const shopName = this.getShopName();
    const lowerCaseShopName = shopName.toLowerCase();
    const slug = this.getSlug(lowerCaseShopName);
    return `/${slug}`;
  },

  getShopEmail() {
    const shop = Shops.find({
      _id: this.getShopId()
    }, {
      limit: 1,
      fields: {
        emails: 1
      }
    }).fetch()[0];
    return shop && shop.emails && shop.emails[0].address;
  },

  getShopSettings(name = "core") {
    const settings = Packages.findOne({ name: name, shopId: this.getShopId() }) || {};
    return settings.settings || {};
  },

  getShopCurrency() {
    const shop = Shops.findOne({
      _id: this.getShopId()
    });

    return shop && shop.currency || "USD";
  },

  // TODO: Marketplace - should each shop set their own default language or
  // should the Marketplace set a language that's picked up by all shops?
  getShopLanguage() {
    const { language } = Shops.findOne({
      _id: this.getShopId()
    }, {
      fields: {
        language: 1
      } }
    );
    return language;
  },

  getPackageSettings(name) {
    return Packages.findOne({ name: name, shopId: this.getShopId() }) || null;
  },

  /**
   * getMarketplaceSettings finds the enabled `reaction-marketplace` package for
   * the primary shop and returns the settings
   * @method getMarketplaceSettings
   * @return {Object} The marketplace settings from the primary shop or undefined
   */
  getMarketplaceSettings() {
    const marketplace = Packages.findOne({
      name: "reaction-marketplace",
      shopId: this.getPrimaryShopId(),
      enabled: true
    });

    if (marketplace && marketplace.settings) {
      return marketplace.settings;
    }
    return {};
  },

  // options:  {packageName, preference, defaultValue}
  getUserPreferences(options) {
    const { userId, packageName, preference, defaultValue } = options;

    if (!userId) {
      return undefined;
    }

    const user = Meteor.users.findOne({ _id: userId });

    if (user) {
      const profile = user.profile;
      if (profile && profile.preferences && profile.preferences[packageName] && profile.preferences[packageName][preference]) {
        return profile.preferences[packageName][preference];
      }
    }
    return defaultValue || undefined;
  },

  /**
   *  insertPackagesForShop
   *  insert Reaction packages into Packages collection registry for a new shop
   *  Assigns owner roles for new packages
   *  Imports layouts from packages
   *  @param {String} shopId - the shopId to create packages for
   *  @return {String} returns insert result
   */
  insertPackagesForShop(shopId) {
    const layouts = [];
    if (!shopId) {
      return [];
    }

    // Check to see what packages should be enabled
    const shop = Shops.findOne({ _id: shopId });
    const marketplaceSettings = this.getMarketplaceSettings();
    let enabledPackages;

    // Unless we have marketplace settings and an enabledPackagesByShopTypes Array
    // we will skip this
    if (marketplaceSettings &&
        marketplaceSettings.shops &&
        Array.isArray(marketplaceSettings.shops.enabledPackagesByShopTypes)) {
      // Find the correct packages list for this shopType
      const matchingShopType = marketplaceSettings.shops.enabledPackagesByShopTypes.find(
        EnabledPackagesByShopType => EnabledPackagesByShopType.shopType === shop.shopType);
      if (matchingShopType) {
        enabledPackages = matchingShopType.enabledPackages;
      }
    }

    const packages = this.Packages;
    // for each shop, we're loading packages in a unique registry
    // Object.keys(pkgConfigs).forEach((pkgName) => {
    for (const packageName in packages) {
      // Guard to prvent unexpected `for in` behavior
      if ({}.hasOwnProperty.call(packages, packageName)) {
        const config = packages[packageName];
        this.assignOwnerRoles(shopId, packageName, config.registry);

        const pkg = Object.assign({}, config, {
          shopId: shopId
        });

        // populate array of layouts that don't already exist (?!)
        if (pkg.layout) {
          // filter out layout templates
          for (const template of pkg.layout) {
            if (template && template.layout) {
              layouts.push(template);
            }
          }
        }

        if (enabledPackages && Array.isArray(enabledPackages)) {
          if (enabledPackages.indexOf(pkg.name) === -1) {
            pkg.enabled = false;
          }
        }
        Packages.insert(pkg);
        Logger.debug(`Initializing ${shopId} ${packageName}`);
      }
    }

    // helper for removing layout duplicates
    const uniqLayouts = uniqWith(layouts, _.isEqual);
    Shops.update({ _id: shopId }, { $set: { layout: uniqLayouts } });
  },

  getAppVersion() {
    return Shops.findOne().appVersion;
  },

  /**
   * createDefaultAdminUser
   * @summary Method that creates default admin user
   * Settings load precendence:
   *  1. environment variables
   *  2. settings in meteor.settings
   * @returns {String} return userId
   */
  createDefaultAdminUser() {
    const shopId = this.getShopId();

    // if an admin user has already been created, we'll exit
    if (Roles.getUsersInRole("owner", shopId).count() !== 0) {
      Logger.debug("Not creating default admin user, already exists");
      return ""; // this default admin has already been created for this shop.
    }

    // run hooks on options object before creating user (the options object must be returned from all callbacks)
    let options = {};
    options = Hooks.Events.run("beforeCreateDefaultAdminUser", options);

    // If $REACTION_SECURE_DEFAULT_ADMIN is set to "true" on first run,
    // a random email/password will be generated instead of using the
    // default email and password (email: admin@localhost pw: r3@cti0n)
    // and the new admin user will need to verify their email to log in.
    // If a random email and password are generated, the console will be
    // the only place to retrieve them.
    // If the admin email/password is provided via environment or Meteor settings,
    // the $REACTION_SECURE_DEFAULT_ADMIN will only enforce the email validation part.
    const isSecureSetup = process.env.REACTION_SECURE_DEFAULT_ADMIN === "true";

    // generate default values to use if none are supplied
    const defaultEmail = isSecureSetup ? `${Random.id(8).toLowerCase()}@localhost` : "admin@localhost";
    const defaultPassword = isSecureSetup ? Random.secret(8) : "r3@cti0n";
    const defaultUsername = "admin";
    const defaultName = "Admin";

    // Process environment variables and Meteor settings for initial user config.
    // If ENV variables are set, they always override Meteor settings (settings.json).
    // This is to allow for testing environments where we don't want to use users configured in a settings file.
    const env = process.env;
    let configureEnv = false;

    if (env.REACTION_EMAIL && env.REACTION_AUTH) {
      configureEnv = true;
      Logger.info("Using environment variables to create admin user");
    }

    // defaults use either env or generated values
    options.email = env.REACTION_EMAIL || defaultEmail;
    options.password = env.REACTION_AUTH || defaultPassword;
    options.username = env.REACTION_USER_NAME || defaultUsername;
    options.name = env.REACTION_USER || defaultName;

    // or use `meteor --settings`
    if (Meteor.settings && !configureEnv) {
      if (Meteor.settings.reaction) {
        options.email = Meteor.settings.reaction.REACTION_EMAIL || defaultEmail;
        options.password = Meteor.settings.reaction.REACTION_AUTH || defaultPassword;
        options.username = Meteor.settings.reaction.REACTION_USER || defaultUsername;
        options.name = Meteor.settings.reaction.REACTION_USER_NAME || defaultName;
        Logger.info("Using meteor --settings to create admin user");
      }
    }

    // set the default shop email to the default admin email
    Shops.update(shopId, {
      $addToSet: {
        emails: {
          address: options.email,
          verified: true
        }
      }
    });

    // get the current shop
    const shop = Shops.findOne(shopId);

    // add the current domain to the shop if it doesn't already exist
    if (!shop.domains.includes(this.getDomain())) {
      // set the default shop email to the default admin email
      Shops.update(shopId, {
        $addToSet: {
          domains: this.getDomain()
        }
      });
    }

    //
    // create the new admin user
    //
    let accountId;
    // we're checking again to see if this user was created but not specifically for this shop.
    if (Meteor.users.find({ "emails.address": options.email }).count() === 0) {
      accountId = Accounts.createUser(options);
    } else {
      // this should only occur when existing admin creates a new shop
      accountId = Meteor.users.findOne({ "emails.address": options.email })._id;
    }

    // update the user's name if it was provided
    // (since Accounts.createUser() doesn't allow that field and strips it out)
    Meteor.users.update(accountId, {
      $set: {
        name: options.name
      }
    });

    // unless strict security is enabled, mark the admin's email as validated
    if (!isSecureSetup) {
      Meteor.users.update({
        "_id": accountId,
        "emails.address": options.email
      }, {
        $set: {
          "emails.$.verified": true
        }
      });
    } else {
      // send verification email to admin
      sendVerificationEmail(accountId);
    }

    //
    // Set Default Roles
    //
    const defaultAdminRoles = ["owner", "admin", "guest", "account/profile"];
    // we don't use accounts/addUserPermissions here because we may not yet have permissions
    Roles.setUserRoles(accountId, defaultAdminRoles, shopId);
    // // the reaction owner has permissions to all sites by default
    Roles.setUserRoles(accountId, defaultAdminRoles, Roles.GLOBAL_GROUP);
    // initialize package permissions we don't need to do any further permission configuration it is taken care of in the
    // assignOwnerRoles
    const packages = Packages.find().fetch();
    for (const pkg of packages) {
      this.assignOwnerRoles(shopId, pkg.name, pkg.registry);
    }

    // notify user that the default admin was created by
    // printing the account info to the console
    Logger.warn(`\n *********************************
        \n  IMPORTANT! DEFAULT ADMIN INFO
        \n  EMAIL/LOGIN: ${options.email}
        \n  PASSWORD: ${options.password}
        \n ********************************* \n\n`);

    // run hooks on new user object
    const user = Meteor.users.findOne(accountId);
    Hooks.Events.run("afterCreateDefaultAdminUser", user);

    return accountId;
  },

  /**
   *  loadPackages
   *  insert Reaction packages into registry
   *  we check to see if the number of packages have changed against current data
   *  if there is a change, we'll either insert or upsert package registry
   *  into the Packages collection
   *  import is processed on hook in init()
   *  @return {String} returns insert result
   */
  loadPackages() {
    const packages = Packages.find().fetch();

    let registryFixtureData;

    if (process.env.REACTION_REGISTRY) {
      // check the environment for the registry fixture data first
      registryFixtureData = process.env.REACTION_REGISTRY;
      Logger.info("Loaded REACTION_REGISTRY environment variable for registry fixture import");
    } else {
      // or attempt to load reaction.json fixture data
      try {
        registryFixtureData = Assets.getText("settings/reaction.json");
        Logger.info("Loaded \"/private/settings/reaction.json\" for registry fixture import");
      } catch (error) {
        Logger.warn("Skipped loading settings from reaction.json.");
        Logger.debug(error, "loadSettings reaction.json not loaded.");
      }
    }

    if (!!registryFixtureData) {
      const validatedJson = EJSON.parse(registryFixtureData);

      if (!Array.isArray(validatedJson[0])) {
        Logger.warn("Registry fixture data is not an array. Failed to load.");
      } else {
        registryFixtureData = validatedJson;
      }
    }

    const layouts = [];
    // for each shop, we're loading packages in a unique registry
    _.each(this.Packages, (config, pkgName) => {
      return Shops.find().forEach((shop) => {
        const shopId = shop._id;
        if (!shopId) return [];

        // existing registry will be upserted with changes, perhaps we should add:
        this.assignOwnerRoles(shopId, pkgName, config.registry);

        // Settings from the package registry.js
        const settingsFromPackage = {
          name: pkgName,
          icon: config.icon,
          enabled: !!config.autoEnable,
          settings: config.settings,
          registry: config.registry,
          layout: config.layout
        };

        // Setting from a fixture file, most likely reaction.json
        let settingsFromFixture;
        if (registryFixtureData) {
          settingsFromFixture = _.find(registryFixtureData[0], (packageSetting) => {
            return config.name === packageSetting.name;
          });
        }

        // Setting already imported into the packages collection
        const settingsFromDB = _.find(packages, (ps) => {
          return (config.name === ps.name && shopId === ps.shopId);
        });

        const combinedSettings = merge({}, settingsFromPackage, settingsFromFixture || {}, settingsFromDB || {});

        // populate array of layouts that don't already exist in Shops
        if (combinedSettings.layout) {
          // filter out layout Templates
          for (const pkg of combinedSettings.layout) {
            if (pkg.layout) {
              layouts.push(pkg);
            }
          }
        }
        // Import package data
        this.Import.package(combinedSettings, shopId);
        return Logger.debug(`Initializing ${shop.name} ${pkgName}`);
      }); // end shops
    });

    // helper for removing layout duplicates
    const uniqLayouts = uniqWith(layouts, _.isEqual);
    // import layouts into Shops
    Shops.find().forEach((shop) => {
      this.Import.layout(uniqLayouts, shop._id);
    });

    //
    // package cleanup
    //
    Shops.find().forEach((shop) => {
      return Packages.find().forEach((pkg) => {
        // delete registry entries for packages that have been removed
        if (!_.has(this.Packages, pkg.name)) {
          Logger.debug(`Removing ${pkg.name}`);
          return Packages.remove({ shopId: shop._id, name: pkg.name });
        }
        return false;
      });
    });
  },
  setAppVersion() {
    const version = packageJson.version;
    Logger.info(`Reaction Version: ${version}`);
    Shops.update({}, { $set: { appVersion: version } }, { multi: true });
  }
};
