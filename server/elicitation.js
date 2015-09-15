var express = require('express');
var router = express.Router();

var Handlebars = require('handlebars');

var elicitationViewModel = require('./elicitation/view-model');
var includeStatic = require('./elicitation/static-includes');
var authenticateAccessTo = require('./elicitation/auth');

var Promise = require('bluebird');
// FIXME: should only use in dev, not prod
Promise.longStackTraces();

var extend = require('extend');

module.exports = function (db, assetHelpers) {

  function addLogEntry(req, eventType, text, personID, discussionID) {
    var requestArgs = JSON.stringify({
      ua: req.headers['user-agent'],
      queryArgs: req.query,
      postArgs: req.body
    });
    
    return db.models.LogEntry.create({
      InternalEvent: false,
      Person_ID: personID,
      Discussion_ID: discussionID,
      PageInstance: null,
      Date: Date.now(),
      EventType: eventType,
      Text: text,
      RequestArgs: requestArgs
    });
  }

  router.get('/run/:id/:humanreadable?', function (req, res) {
    elicit(req, res, "Elicitation.View+");
  });
  
  router.get('/edit/:id/:humanreadable?', function (req, res) {
    elicit(req, res, "Elicitation.Edit+", { 
      startEditing: true,
      modifyViewModel: function (viewModel) {
        console.warn("FIXME not implemented elicitation.edit support revision version query string");
        /*
        if (revision != null) {
            var definition = db.ElicitationDefinitions.Find(revision);

            if (!elicitation.DefinitionHistory.Contains(definition)) throw new Exception("Specified definitionID " + revision + " is not in the history of elicitation");
            elicitationViewModel.elicitationDefinition = definition.Definition;
            elicitationViewModel.settings.notTheLatestRevision = true;
        }*/
        console.log("Modifying view model!");
        return viewModel;
      }
    });
  });
  
  function authAndLoad(logEventName, elicitationID, req, res, options) {
    options = extend(
      {
        includeElicitationDefinition: false,
        includeDiscussion: false
      }, options
    );
    
    return db.ready
    .then( () =>
      authenticateAccessTo(elicitationID, req, res)
    )
    .then(personID =>
      Promise.props({
        elicitation: db.getElicitation(elicitationID),
        assignment: db.getElicitationAssignment(elicitationID, personID),
        person: db.models.Person.findOne({ where: { ID: personID } })
      })
    )
    .then((m) =>
      addLogEntry(req, logEventName, "ElicitationID: " + elicitationID, m.person.ID, m.elicitation.Discussion_ID)
      .then( () => db.getDiscussionMembership(m.elicitation.Discussion_ID, m.person.ID) )
      .then( membership => extend(m, { membership: membership }) )
    )
    .then((m) =>
      options.includeElicitationDefinition
      ? db.models.ElicitationDefinition.findOne({ where: { ID: m.elicitation.ElicitationDefinition_ID } })
        .then( definition => extend(m, {
          elicitationDefinition: definition
        }))
      : m
    )
    .then((m) =>
      options.includeDiscussion
      ? db.models.Discussion.findOne({ where: { ID: m.elicitation.Discussion_ID } })
        .then( discussion => extend(m, {
          discussion: discussion
        }))
      : m
    );
  }
  
  router.post('/savedefinition/:id/:humanreadable?', function (req, res) {
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
    }
    
    console.warn("FIXME: validate moderator");
    
    authAndLoad("Elicitation.SaveDefinition+", elicitationID, req, res)
    .then( m =>
      db.transaction(function (t) {
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
      })
    ).then(function () {
      console.log("SaveDefinition succeeded!");
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(true));
    });
  });

  /* Accepts JSON data submissions from Expert participants, including page-by-page 'backup' submissions,
  * which will have completed=false, and the final data submit, which will have completed=true */
  router.post('/savedata/:id/:humanreadable?', function (req, res) {

    /* FIXME: todo
            Trace.TraceInformation("ElicitationController.SaveData on id: " + id + " from personID: " + person.ID);

            this.addLogEntry("Elicitation.SaveData", Text: "ElicitationID: " + id);
            db.SaveChanges();
    */

    // URL / Query params:
    var elicitationID = parseInt(req.params.id);
    var elicitation_definition_id = parseInt(req.body.elicitation_definition_id);    
    var ElicitationCompleted = req.body.completed == 1;
    var json = req.body.json;
    
    //console.log("Params are: ", JSON.stringify(req.body));
    
    var now = Date.now();
    
    authAndLoad("Elicitation.SaveData+", elicitationID, req, res)
    .then(function (m) {
      var elicitation = m.elicitation;
      var assignment = m.assignment;
      var membership = m.membership;

      return db.transaction(function (t) {

        membership.LastAccessed = now;            
        assignment.LastAccessed = now;
        assignment.Modified = now;
    
        return db.models.ElicitationData.create({
          ElicitationTask_ID: assignment.ID, // FIXME: sequelize association
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
        
            membership.HasParticipated = true;
            membership.HasCompletedTask = true;
            elicitation.lastCompleted = now;
            membership.LastParticipated = now;

            return addLogEntry("Elicitation Complete", "ElicitationID: " + elicitationID)
            .then( () => db.updateNumAssignedAndCompletedFromDB(elicitation, t) )
            .then( () => membership.save({transaction: t}) )                
            .then( () => assignment.save({transaction: t}) )
            .then( () => elicitation.save({transaction: t}) )
            .then( () =>
              db.models.Discussion.update( 
                { LastActivity: now },
                { where: { ID: elicitation.Discussion_ID }, transaction: t }
              )
            )
          } else {
            return membership.save({transaction: t})
            .then( () => assignment.save({transaction: t}) );
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
    })
    .then(function () {
      console.log("SaveData Success!");
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(true));      
    })
    .catch(function (e) {
      console.warn("FIXME: to implement exception logging and handling in savedata");
      /* FIXME TO IMPLEMENT
            } catch (Exception ex) {
                var exString = ex.ToString();
                Trace.TraceError("ElicitationController.SaveData: error \n" + exString);

                this.addLogEntry("Elicitation.SaveData ERROR", Text: "ElicitationID: " + id + "\nException:\n" + exString + "\n");
                db.SaveChanges();
                throw ex;
            }
      */
    });   
  });

  function renderElicitation(req, res, models, logName, startEditing, embedded, modifyViewModel) {
    return elicitationViewModel(db, models, logName, startEditing, embedded)
    .then(modifyViewModel)
    .then(viewModel => {
      viewModel.helpers = {
        includeStatic: function(filename) { return new Handlebars.SafeString(includeStatic(filename)); },
        css: function(filename) { return new Handlebars.SafeString(assetHelpers.css(filename)); },
        js: function(filename) { return new Handlebars.SafeString(assetHelpers.js(filename)); },
        assetPath: function(filename) { return new Handlebars.SafeString(assetHelpers.assetPath(filename)); },
        jsonStringify: function(obj) { return new Handlebars.SafeString(JSON.stringify(obj)); }
      };
      viewModel.layout = false;
          
      res.render('elicitation-backend-layout', viewModel);
    });
  }
  

  function elicit(req, res, logName, options) {
    var options = options || {};
    var startEditing = options.startEditing != undefined ? options.startEditing : false;
    var embedded = options.embedded != undefined ? options.embedded : false;
    var modifyViewModel = options.modifyViewModel || function (viewModel) { return viewModel; };
    
    var elicitationID = parseInt(req.params.id);
    console.log(logName + "(" + elicitationID + ")");

    return authAndLoad("Elicitation.SaveDefinition+", elicitationID, req, res, { 
      includeElicitationDefinition: true,
      includeDiscussion: true
    })
    .then( models =>
      renderElicitation(req, res, models, "Elicitation.View+", startEditing, embedded, modifyViewModel)
    )
    .catch(authenticateAccessTo.RedirectToLoginError, 
      redirect => res.redirect(redirect.url)
    );
    
  } 
  
  return router;
}
