
/**
* Module dependencies.
*/

var express = require('express')
, http = require('http')
, path = require('path')
, exphbs  = require('express-handlebars')
, connectAssets = require('connect-assets');

var app = express();

var expressHandlebars = exphbs.create({
  defaultLayout: "main",
  extname: ".hbs"
});

var connectAssetsHelpers = {};

console.log("env is: ", app.get('env'));

app.configure(function(){
  app.set('port', process.env.PORT || 3000);

  app.engine('.hbs', expressHandlebars.engine);
  app.set('view engine', '.hbs');
  
  app.set('views', __dirname + '/server/views');

  app.use(express.favicon());
  app.use(express.logger('dev'));
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  
  app.use(connectAssets({
    paths: [
      'app',
      'public'
    ],
    helperContext: connectAssetsHelpers
  }));
    
  app.use(app.router);

  app.use(express.static('public'));
  app.use('/app/widgets/thumbnails', express.static('app/widgets/thumbnails'));
});

app.configure('development', function(){
  app.use(express.errorHandler());
});

app.get('/', function (req, res) {  
  res.render('home', {
    title: "bumpy"
  });
});

var connectionString = process.env['SQLAZURECONNSTR_DefaultConnection'];
var NZDB = require('./server/nzdb');
var db = new NZDB(connectionString);

var elicitationRoutes = require('./server/elicitation')(db, connectAssetsHelpers);

app.get('/elicitation/run/:id', elicitationRoutes.run);

http.createServer(app).listen(app.get('port'), function(){
  console.log("Express server listening on port " + app.get('port'));
});
