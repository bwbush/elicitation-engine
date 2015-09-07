var Sequelize = require('sequelize');
var ncsBuilder = require('node-connection-string-builder');
var nzdbModels = require('./nzdb-models');


function connectionStringToConfig(connectionString) {
  var config = {
    server: undefined,
    userName: undefined,
    password: undefined
    ,options: {
      debug: {
        packet: true,
        data: true,
        payload: true,
        token: false,
        log: true
      },
      database: 'NearZero',
      encrypt: true // for Azure users
    }
  };
    
  var builder=new ncsBuilder(connectionString);
  if (builder.dataSource) {
    var ds=builder.dataSource.split('\\', 2);
    config.server=ds[0] || config.server; 
    var instanceName=ds[1] || config.options.instanceName;
    if (instanceName)
      config.options.instanceName=instanceName;
  }
  config.userName=builder.userID || config.userName;
  config.password=builder.password || config.password;
  config.options.encrypt=builder.encrypt || config.options.encrypt;
  config.options.database=builder.initialCatalog || config.options.database;  
  
  return config;
}



var NZDB = function (connectionString) {
  var config = connectionStringToConfig(connectionString)

  this.sql = new Sequelize(config.database, config.userName, config.password, {
    host: config.server,
    dialect: 'mssql',
    pool: {
      max: 5,
      min: 0,
      idle: 10000
    },
    dialectOptions: {
      encrypt: true,
      database: 'NearZero'
    }
  });
  
  this.sql.authenticate()
    .then(function () {
      console.log("NZDB(): connected  via sequelize");  
      this.models = nzdbModels(this.sql, Sequelize);
    }.bind(this))
    .catch(function (err) { 
      console.log("NZDB(): couldn't auth with db: ", err);
    });
}


NZDB.prototype.getElicitationDefinitionFromID = function(id, cb) {
  this.models.ElicitationDefinitions.findOne({ where: { ID: id } })
  .then(function (def) {
    cb(null, def);
  }).catch(function (err) { 
    cb(err, null);
  });
}

NZDB.prototype.getElicitationFromID = function (id, cb) {
  this.models.Tasks.findOne({ 
    where: {
      ID: id, 
      Discriminator: 'Elicitation' 
    }})
  .then(function (elicitation) {
    cb(null, elicitation);
  }).catch(function (err) { 
    cb(err, null);
  });
}

NZDB.prototype.getElicitationAndAssets = function(elicitationID, cb) {
  this.getElicitationFromID(elicitationID, function (err, elicitation) {
    if (err) {
      cb(err, null);
    } else {
      this.getElicitationDefinitionFromID(elicitation.ElicitationDefinition_ID, function (err, definition) {
        cb(null, {
          elicitation: elicitation,
          definition: definition
        });
      });
    }
  }.bind(this));
}

module.exports = NZDB;