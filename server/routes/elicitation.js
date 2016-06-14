var express = require('express');
var router = express.Router();

var elicitationViewModel = require('../elicitation/view-model');

var authenticateAccessTo = require('../elicitation/auth');
var handlebarsHelpers = require('../utils/handlebars-helpers');

var Promise = require('bluebird');
// FIXME: should only use in dev, not prod
Promise.longStackTraces();

var extend = require('extend');

module.exports = function (db, assetHelpers) {
  var dbHelper = require('../elicitation/db-helper')(db);
  var addLogEntry = dbHelper.addLogEntry;
  
  router.get('/run/:id/:humanreadable?', function (req, res, next) {
    var resumePriorSessionData = req.query.resumePriorSessionData !== "false";
    var embedded = req.query.embedded === "true";
    
    elicit(req, res, next, "Elicitation.View+", {
      modifyViewModel: function (viewModel, models) {
        viewModel.settings.embedded = embedded;
        
        if (models.assignment == null) {
          throw "Cannot run this elicitation, it has not been assigned to you";
        }
        
        models.assignment.LastBrowserUserAgent = req.headers['user-agent'];
        models.assignment.LastAccessed = Date.now();
        
        return models.assignment.save()
        .then(function () {
          if (resumePriorSessionData) {
            return db.models.ElicitationData.findOne({
              where: { ElicitationTask_ID: models.assignment.ID },
              order: [['Modified', 'DESC']]
            }).then(function (latestData) {
              if (latestData && !latestData.Completed) {
                viewModel.elicitationPriorSessionData = latestData.JSON;
              }
            });
          }
        }).then(function () {
          return viewModel;
        });
      }
    })
  });
  
  router.get('/edit/:id/:humanreadable?', function (req, res, next) {
    var revision = parseInt(req.query.revision);
    
    elicit(req, res, next, "Elicitation.Edit+", { 
      startEditing: true,
      modifyViewModel: function (viewModel, models) {
        if (revision) {
          return db.models.ElicitationDefinition.findOne({ where: { ID: revision, Elicitation_ID: models.elicitation.ID } })
          .then(throwIfNull)
          .then(function (definition) {
            viewModel.elicitationDefinition = definition.Definition;
            viewModel.settings.notTheLatestRevision = true;              
            
            return viewModel;
          });
        } else {
          return viewModel;
        }
      }
    });
  });
  
  router.get('/review/:reviewtoken/:humanreadable?', function (req, res, next) {
    elicit(req, res, next, "Elicitation.Edit+", {
      loadModels: function (req, res, logName) {
        var reviewToken = req.params.reviewtoken;
        return dbHelper.loadReviewModels(reviewToken);
      },
      modifyViewModel: function (viewModel) {

        viewModel.settings.switchToReviewModeAfterLoading = true;
        viewModel.settings.allowEditing = false;
        viewModel.settings.switchToEditModeAfterLoading = false;

        return viewModel;
      }
    });
  });
  
  function generateAlphanumericPassword() {
    return (Math.random()*1e32).toString(36).slice(0,14);
  }
  
  function createPersonForOpenAccess(elicitation) {
    var now = Date.now();
    var token = generateAlphanumericPassword();
    return db.models.Person.create({
      FirstName: "Open",
      LastName: "Access",
      affiliation: "-",
      email: "openaccess" + token + "@nearzero.org",
      DoNotEmail: true,
      DoNotEmailActiveOptOut: true,
      access_token: token,
      AutogeneratedByOpenAccess: true        
    })
    .then(person =>
      db.models.TaskAssignment.create({
        Task_ID: elicitation.ID,
        Person_ID: person.ID,
        Completed: false,
        Created: now,
        Modified: now,
        Discriminator: 'ElicitationAssignment'
      })
      .then(function () {
        return person;
      })
    );
  }
  
  router.get('/access/:openaccesstoken/:humanreadable?', function (req, res, next) {
    var openAccessToken = req.params.openaccesstoken;
    
    db.ready
    .then(() => db.getElicitationForOpenAccess(openAccessToken))
    .then(elicitation => 
      createPersonForOpenAccess(elicitation)
      .then(function (person) {
        return addLogEntry(req, "Open Access", "ElicitationID: " + elicitation.ID + ", PersonID: " + person.ID)
        .then(function () {
          var url = req.baseUrl + "/run/" + encodeURIComponent(elicitation.ID) + "?login=" + encodeURIComponent(person.access_token);
          return res.redirect(url);
        });
      })
    )
    .catch(e => next(e))
  });
  
  router.post('/savedefinition/:id/:humanreadable?', function (req, res, next) {
    var now = Date.now();
        
    // URL / Query params:
    var elicitationID = parseInt(req.params.id);
    var changeSummary = req.body.ChangeSummary;
    var definitionText = req.body.ElicitationDefinition;    
    
    var SaveAsNewElicitation = req.body.SaveAsNewElicitation == "true";
    var SaveAsNewElicitationname = req.body.SaveAsNewElicitationName;    
    console.warn("FIXME: elicitation.savedefinition.SaveAsNewElicitation is not implemented");
    if (SaveAsNewElicitation) {
      throw "SaveAsNewElicitation is not implemented";
      /* FIXME: TO IMPLEMENT:
            if (SaveAsNewElicitation) {
                var oldElicitation = elicitation;
                elicitation = (Elicitation)oldElicitation.Clone(db, db);
                elicitation.ElicitationName = SaveAsNewElicitationName;
                db.SaveChanges();
            }
      */
      // After implementing server side:
      // To re-enable feature in client remove display=none in eat.hbs on "Save a Copy As" <li> item
    }
    
    dbHelper.authAndLoad("Elicitation.SaveDefinition+", elicitationID, req, res, { requireModOrAdmin: true })
    .then(function (m) {
      return db.transaction(function (t) {
        return db.models.ElicitationDefinition.create({
          Definition: definitionText,
          ChangeSummary: changeSummary,
          Elicitation_ID: m.elicitation.ID,
          Created: now,
          Modified: now,
          CreatedBy_ID: m.person.ID
        }, {transaction: t}).then( newDefinition => {
          m.elicitation.ElicitationDefinition_ID = newDefinition.ID;
          m.elicitation.Modified = now;
          
          return m.elicitation.save({transaction: t})
          .then( () =>
            db.models.Discussion.update( 
              { LastActivity: now },
              { where: { ID: m.elicitation.Discussion_ID }, transaction: t }
            )
          )
        });
      }).then( function () {
        console.warn("FIXME: updating per widget results not yet implemented");
        /* FIXME TO IMPLEMENT:
          foreach (var perWidgetResult in elicitation.PerWidgetResults) {
              perWidgetResult.UpdateFromElicitationDefinition(dbRequiredForDeleting: this.db);
          }
          db.SaveChanges();
        */
      });
    }).then(function () {
      console.log("SaveDefinition succeeded!");
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(true));
    }).catch(function (e) {
      next(e);
    })
  });

  /* Accepts JSON data submissions from Expert participants, including page-by-page 'backup' submissions,
  * which will have completed=false, and the final data submit, which will have completed=true */
  router.post('/savedata/:id/:humanreadable?', function (req, res, next) {

    // URL / Query params:
    var elicitationID = parseInt(req.params.id);
    var elicitation_definition_id = parseInt(req.body.elicitation_definition_id);    
    var ElicitationCompleted = req.body.completed == 1;
    var json = req.body.json;
    
    //console.log("Params are: ", JSON.stringify(req.body));
    
    var now = Date.now();
    
    dbHelper.authAndLoad("Elicitation.SaveData+", elicitationID, req, res)
    .then(function (m) {
      var elicitation = m.elicitation;
      var assignment = m.assignment;
      var membership = m.membership;
      
      return db.transaction(function (t) {

        if (membership) membership.LastAccessed = now;            
        assignment.LastAccessed = now;
        assignment.Modified = now;
    
        return db.models.ElicitationData.create({
          ElicitationTask_ID: assignment.ID,
          JSON: json,
          Completed: ElicitationCompleted,
          Created: now,
          Modified: now,
          ElicitationDefinition_ID: elicitation_definition_id,
          BrowserUserAgent: req.headers['user-agent']
        }, {transaction: t}).then( function (elicitationData) {
          if (ElicitationCompleted) {                
            assignment.CompletedElicitationData_ID = elicitationData.ID;
            assignment.Completed = true;
        
            if (membership) {
              membership.HasParticipated = true;
              membership.HasCompletedTask = true;
              membership.LastParticipated = now;              
            }
            elicitation.lastCompleted = now;
            
            return addLogEntry(req, "Elicitation Complete", "ElicitationID: " + elicitationID, m.person.ID, m.elicitation.Discussion_ID)
            .then( () => db.updateNumAssignedAndCompletedFromDB(elicitation, t) )
            .then( () => membership ? membership.save({transaction: t}) : Promise.resolve() )
            .then( () => assignment.save({transaction: t}) )
            .then( () => elicitation.save({transaction: t}) )
            .then( () =>
              elicitation.Discussion_ID ?
                db.models.Discussion.update( 
                  { LastActivity: now },
                  { where: { ID: elicitation.Discussion_ID }, transaction: t }
                ) 
                : Promise.resolve()
            )
          } else {
            return assignment.save({transaction: t})
            .then( () => membership ? membership.save({transaction: t}) : Promise.resolve() );
          }
        });

      }).then(function () {
        // update per-widget results
        if (ElicitationCompleted) {
          console.warn("FIXME: not updating per-widget results as per ElicitationController.cs");
          /* FIXME TO IMPLEMENT
              if (ElicitationCompleted) {
                  // Update Per-Widget Results
                  try {
                      foreach (var perWidgetResults in elicitation.PerWidgetResults) {
                          perWidgetResults.AddElicitationData(elicitationData);
                      }
                      db.SaveChanges();
                  } catch (Exception e) {
                      // FIXME: log exception
                      Trace.TraceError("ElicitationController.SaveData: error updating per-widget results\n" + e.ToString());
                      var message = e.Message;
                  }

                  // Email the moderators, let them know an expert submitted an elicitation
                  try {
                      var domainName = NearZero.Models.NZConfiguration.DomainName;
                      if (domainName != "127.0.0.1") {
                          var formattedJSON = JObject.Parse(json).ToString();

                          string elicitationName = elicitation.ElicitationName;

                          var message = new MailMessage {
                              From = elicitation.Discussion.getMailAddress(domainName),
                              Subject = "Elicitation Completed (" + elicitationName.ToString() + ")",
                              Body = person.name + " completed the elicitation"
                          };
                          foreach (var moderator in elicitation.Discussion.Moderators) {
                              message.To.Add(new MailAddress(moderator.email, moderator.name));
                          }
                          MessageSender.SendMailMessage(message);
                          //AmazonSES.send(message);
                      }
                  } catch (Exception e) {
                      Trace.TraceError("ElicitationController.SaveData: error sending moderators a message\n" + e.ToString());
                  }

                  Trace.TraceInformation("ElicitationController.SaveData: complete submission from " + person.ID);
              }
          */
        }
      })
      .catch(function (e) {
        console.error("Exception in Elicitation.SaveData: ", e);
        
        res.status(500);
        res.send("Uhoh! There was a problem saving data to our server :-(");
        return addLogEntry(req, "Elicitation.SaveData+ ERROR", "ElicitationID: " + elicitationID + "\nException:\n" + e + "\n\nData was: " + json, m.person.ID, m.elicitation.Discussion_ID)
        .then(function () {
          next(e);
        });
      });    
    })
    .then(function () {
      console.log("SaveData Success!");
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(true));      
    });
  });
  
  function throwIfNull(x) {
    if (x === null) {
      throw "Couldn't find required resource in database";
    } else {
      return x;
    }
  }

  function setupViewModel(baseURL, models, logName, startEditing, embedded) {
    return elicitationViewModel(baseURL, db, models, logName, startEditing, embedded)
    .then(viewModel => {
      viewModel.helpers = handlebarsHelpers(assetHelpers);
      viewModel.layout = false;
      return viewModel;
    });
  }

  function elicit(req, res, next, logName, options) {
    var o = extend({
      startEditing: false,
      embedded: false,
      modifyViewModel: (viewModel, models) => viewModel,
      loadModels: function (req, res, logName) {
        var elicitationID = parseInt(req.params.id);
        console.log(logName + "(" + elicitationID + ")");

        return dbHelper.authAndLoad(logName, elicitationID, req, res, { 
          includeElicitationDefinition: true,
          includeDiscussion: true,
          requireModOrAdmin: o.startEditing
        });        
      }
    }, options);

    return o.loadModels(req, res, logName)
    .then( models =>
      setupViewModel(req.baseUrl, models, logName, o.startEditing, o.embedded)
      .then(viewModel => o.modifyViewModel(viewModel, models))
    )
    .then (viewModel =>
      res.render('elicitation-backend-layout', viewModel)
    )
    .catch(authenticateAccessTo.RedirectToLoginError, 
      redirect => res.redirect(redirect.url)
    )
    .catch(function (e) {
      next(e);
    });
    
  }
  
  return router;
}
